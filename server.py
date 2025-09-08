import os, sqlite3, hashlib, secrets, datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room

# Flask с static/
app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["SECRET_KEY"] = "devsecret"
socketio = SocketIO(app, cors_allowed_origins="*")

DB = "database.db"
ONLINE = set()  # usernames online in this process

# ---------------------- DB helpers ----------------------
def db():
    return sqlite3.connect(DB, check_same_thread=False)

def init_db():
    with db() as con:
        cur = con.cursor()
        cur.execute("""CREATE TABLE IF NOT EXISTS users(
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            token    TEXT,
            first_name TEXT,
            last_name  TEXT,
            avatar_url TEXT,
            last_seen  DATETIME
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS chats(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            a TEXT NOT NULL,
            b TEXT NOT NULL,
            UNIQUE(a,b)
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            sender  TEXT NOT NULL,
            type    TEXT NOT NULL DEFAULT 'text', -- text|gif
            text    TEXT NOT NULL,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP,
            read INTEGER DEFAULT 0
        )""")
        con.commit()

def hash_pass(p: str) -> str:
    return hashlib.sha256(p.encode("utf-8")).hexdigest()

def auth_user(token: str):
    if not token:
        return None
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT username, first_name, last_name, avatar_url, COALESCE(last_seen,'') FROM users WHERE token=?", (token,))
        r = cur.fetchone()
        if not r: return None
        u, fn, ln, av, ls = r
        return {"username": u, "first_name": fn or "", "last_name": ln or "", "avatar_url": av or "", "last_seen": ls or ""}

def ensure_chat(u1: str, u2: str):
    a, b = sorted([u1, u2])
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT id FROM chats WHERE a=? AND b=?", (a,b))
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute("INSERT INTO chats(a,b) VALUES(?,?)", (a,b))
        con.commit()
        return cur.lastrowid

def chat_peer(chat_id: int, me: str):
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT a,b FROM chats WHERE id=?", (chat_id,))
        row = cur.fetchone()
        if not row: return None
        a,b = row
        return b if a==me else a

# ---------------------- Routes ----------------------
@app.route("/")
def root():
    # отдаём index.html из static/
    return send_from_directory("static", "index.html")

@app.route("/register", methods=["POST"])
def register():
    data = request.json or {}
    u = (data.get("username") or "").strip()
    p = data.get("password") or ""
    if not u or not p:
        return jsonify(ok=False, error="username/password required"), 400
    if len(p) < 8 or p.lower()==p or p.upper()==p or not any(c.isdigit() for c in p):
        return jsonify(ok=False, error="weak password"), 400
    token = secrets.token_hex(16)
    with db() as con:
        cur = con.cursor()
        try:
            cur.execute("INSERT INTO users(username,password,token,last_seen) VALUES(?,?,?,?)",
                        (u, hash_pass(p), token, datetime.datetime.utcnow().isoformat()))
            con.commit()
        except sqlite3.IntegrityError:
            return jsonify(ok=False, error="user exists"), 409
    return jsonify(ok=True, token=token, username=u)

@app.route("/login", methods=["POST"])
def login():
    data = request.json or {}
    u = (data.get("username") or "").strip()
    p = data.get("password") or ""
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT password FROM users WHERE username=?", (u,))
        r = cur.fetchone()
        if not r or r[0] != hash_pass(p):
            return jsonify(ok=False, error="invalid credentials"), 401
        token = secrets.token_hex(16)
        cur.execute("UPDATE users SET token=?, last_seen=? WHERE username=?",
                    (token, datetime.datetime.utcnow().isoformat(), u))
        con.commit()
    return jsonify(ok=True, token=token, username=u)

@app.route("/me")
def me():
    token = request.headers.get("Authorization","").replace("Bearer ","")
    user = auth_user(token)
    if not user: return jsonify(ok=False), 401
    user["online"] = user["username"] in ONLINE
    return jsonify(ok=True, user=user)

@app.route("/profile", methods=["POST"])
def update_profile():
    token = request.headers.get("Authorization","").replace("Bearer ","")
    user = auth_user(token)
    if not user: return jsonify(ok=False), 401
    
    data = request.json or {}
    first_name = data.get("first_name", "")
    last_name = data.get("last_name", "")
    avatar = data.get("avatar", "")
    
    with db() as con:
        cur = con.cursor()
        cur.execute("UPDATE users SET first_name=?, last_name=?, avatar_url=? WHERE username=?",
                    (first_name, last_name, avatar, user["username"]))
        con.commit()
    
    return jsonify(ok=True)

@app.route("/search_user")
def search_user():
    q = (request.args.get("username") or "").strip()
    if not q: return jsonify(ok=True, results=[])
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT username, first_name, last_name, avatar_url FROM users WHERE username LIKE ? LIMIT 20", (f"%{q}%",))
        rows = cur.fetchall()
    results = [{"username":u,"first_name":fn or "","last_name":ln or "","avatar_url":av or ""} for u,fn,ln,av in rows]
    return jsonify(ok=True, results=results)

@app.route("/create_chat", methods=["POST"])
def create_chat():
    token = request.headers.get("Authorization","").replace("Bearer ","")
    me = auth_user(token)
    if not me: return jsonify(ok=False), 401
    peer = (request.json or {}).get("peer","").strip()
    if peer == me["username"]:
        return jsonify(ok=False, error="self"), 400
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT username, first_name, last_name, avatar_url FROM users WHERE username=?", (peer,))
        r = cur.fetchone()
        if not r: return jsonify(ok=False, error="peer not found"), 404
    chat_id = ensure_chat(me["username"], peer)
    return jsonify(ok=True, chat_id=chat_id)

@app.route("/contacts")
def contacts():
    token = request.headers.get("Authorization","").replace("Bearer ","")
    me = auth_user(token)
    if not me: return jsonify(ok=False), 401
    u = me["username"]
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT id,a,b FROM chats WHERE a=? OR b=?", (u,u))
        chats = cur.fetchall()
        items = []
        for cid, a, b in chats:
            peer = b if a==u else a
            cur.execute("SELECT username, first_name, last_name, avatar_url, last_seen FROM users WHERE username=?", (peer,))
            up = cur.fetchone()
            if not up:  # peer deleted
                continue
            p_user, fn, ln, av, ls = up
            online = p_user in ONLINE
            cur.execute("SELECT text,type,ts,sender FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1", (cid,))
            last = cur.fetchone()
            last_text = (("[GIF]" if last and last[1]=="gif" else (last[0] if last else "")))
            if last and last[3]==u and last[1]=="text":
                last_text = f"Вы: {last_text}"
            cur.execute("SELECT COUNT(*) FROM messages WHERE chat_id=? AND sender<>? AND read=0", (cid,u))
            unread = cur.fetchone()[0]
            items.append({
                "chat_id": cid,
                "peer": {"username": p_user, "first_name": fn or "", "last_name": ln or "", "avatar_url": av or ""},
                "last_text": last_text,
                "online": online,
                "last_seen": ls or "",
                "unread": unread
            })
    return jsonify(ok=True, items=sorted(items, key=lambda x: x["chat_id"], reverse=True))

@app.route("/history")
def history():
    token = request.headers.get("Authorization","").replace("Bearer ","")
    me = auth_user(token)
    if not me: return jsonify(ok=False), 401
    chat_id = int(request.args.get("chat_id",0))
    with db() as con:
        cur = con.cursor()
        cur.execute("SELECT id, sender, type, text, ts FROM messages WHERE chat_id=? ORDER BY id ASC", (chat_id,))
        msgs = [{"id":i,"sender":s,"type":t,"text":txt,"ts":ts} for i,s,t,txt,ts in cur.fetchall()]
        # mark as read
        cur.execute("UPDATE messages SET read=1 WHERE chat_id=? AND sender<>?", (chat_id, me["username"]))
        con.commit()
    return jsonify(ok=True, messages=msgs)

# ---------------------- Socket.IO ----------------------
@socketio.on("connect")
def sio_connect():
    token = request.args.get("token")
    user = auth_user(token)
    if not user:
        return False
    username = user["username"]
    join_room(f"user:{username}")
    ONLINE.add(username)
    with db() as con:
        con.execute("UPDATE users SET last_seen=? WHERE username=?",
                    (datetime.datetime.utcnow().isoformat(), username))
        con.commit()
    emit("presence", {"username": username, "online": True}, broadcast=True)

@socketio.on("disconnect")
def sio_disconnect():
    username = None
    token = request.args.get("token")
    user = auth_user(token)
    if user:
        username = user["username"]
    if username and username in ONLINE:
        ONLINE.discard(username)
        with db() as con:
            con.execute("UPDATE users SET last_seen=? WHERE username=?",
                        (datetime.datetime.utcnow().isoformat(), username))
            con.commit()
        emit("presence", {"username": username, "online": False}, broadcast=True)

@socketio.on("join_chat")
def join_chat(data):
    chat_id = int(data.get("chat_id"))
    join_room(f"chat:{chat_id}")

@socketio.on("typing")
def typing(data):
    chat_id = int(data.get("chat_id"))
    me = data.get("me")
    emit("typing", {"chat_id": chat_id, "from": me}, to=f"chat:{chat_id}", include_self=False)

@socketio.on("send_message")
def send_message(data):
    token = data.get("token")
    me = auth_user(token)
    if not me:
        return
    me = me["username"]
    chat_id = int(data.get("chat_id", 0))
    msg_type = data.get("type","text")
    text = (data.get("text") or "").strip()
    if not text:
        return
    
    # Auto-create chat if it doesn't exist (for first message)
    if chat_id == 0:
        peer = data.get("peer")
        if peer:
            chat_id = ensure_chat(me, peer)
    
    with db() as con:
        cur = con.cursor()
        cur.execute("INSERT INTO messages(chat_id,sender,type,text) VALUES(?,?,?,?)", (chat_id, me, msg_type, text))
        con.commit()
        mid = cur.lastrowid
        cur.execute("SELECT ts FROM messages WHERE id=?", (mid,))
        ts = cur.fetchone()[0]
        
        # Get peer username to notify
        peer_username = chat_peer(chat_id, me)
        if peer_username:
            emit("new_message_notification", {
                "chat_id": chat_id,
                "from": me,
                "message": {"id": mid, "sender": me, "type": msg_type, "text": text, "ts": ts}
            }, to=f"user:{peer_username}")
    
    payload = {"id": mid, "chat_id": chat_id, "sender": me, "type": msg_type, "text": text, "ts": ts}
    emit("message", payload, room=f"chat:{chat_id}")

# ---- Call signaling ----
@socketio.on("call-offer")
def call_offer(data):
    to = data.get("to")
    emit("call-offer", data, room=f"user:{to}")

@socketio.on("call-answer")
def call_answer(data):
    to = data.get("to")
    emit("call-answer", data, room=f"user:{to}")

@socketio.on("call-decline")
def call_decline(data):
    to = data.get("to")
    emit("call-decline", data, room=f"user:{to}")

@socketio.on("call-end")
def call_end(data):
    to = data.get("to")
    emit("call-end", data, room=f"user:{to}")

@socketio.on("ice-candidate")
def ice_candidate(data):
    to = data.get("to")
    emit("ice-candidate", data, room=f"user:{to}")

# ---- Avatar updates ----
@socketio.on("avatar-updated")
def avatar_updated(data):
    username = data.get("username")
    avatar_url = data.get("avatar_url")
    # Broadcast to all users
    emit("avatar-updated", {"username": username, "avatar_url": avatar_url}, broadcast=True, include_self=False)

# ---------------------- main ----------------------
import os

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # SocketIO обязательно, иначе WebSocket не будет работать
    socketio.run(app, host="0.0.0.0", port=port)
