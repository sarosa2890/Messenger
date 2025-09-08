// ====== helpers ======
const $ = s => document.querySelector(s);
const el = (t, cls) => Object.assign(document.createElement(t), {className: cls||""});
const API = {
  async get(path){ return (await fetch(path, {headers: authHeader()})).json(); },
  async post(path, body){ return (await fetch(path, {method:"POST", headers: {...authHeader(),"Content-Type":"application/json"}, body: JSON.stringify(body)})).json(); }
};
const authHeader = ()=> localStorage.token ? {"Authorization":"Bearer "+localStorage.token} : {};

let me=null, socket=null, activeChat=null, chats=[];

// ====== Settings ======
const Settings = {
  notifications: JSON.parse(localStorage.notifications ?? "true"),
  sounds: JSON.parse(localStorage.sounds ?? "true"),
  autoMedia: JSON.parse(localStorage.autoMedia ?? "false"),
};
function saveSettings(){
  localStorage.notifications = Settings.notifications;
  localStorage.sounds = Settings.sounds;
  localStorage.autoMedia = Settings.autoMedia;
}

// ====== Sounds ======
const Sounds = {
  send: new Audio("/static/sounds/send.mp3"),
  receive: new Audio("/static/sounds/receive.mp3"),
  call: new Audio("/static/sounds/ringtone.mp3"),
};
function playSound(name){
  if(!Settings.sounds) return;
  const a = Sounds[name];
  if(a){
    a.currentTime = 0;
    a.play().catch(()=>{});
  }
}

// ====== Auth modal ======
function showAuth(show=true){ $("#auth").style.display = show ? "flex":"none"; }
function setTab(id){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===id));
  document.querySelectorAll(".pane").forEach(p=>p.classList.toggle("show", p.id==="pane-"+id));
}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
$("#do-register").onclick=async ()=>{
  const r = await API.post("/register",{username:$("#r-username").value.trim(), password:$("#r-password").value});
  if(!r.ok) return alert(r.error||"Ошибка регистрации");
  localStorage.token=r.token; await boot();
};
$("#do-login").onclick=async ()=>{
  const r = await API.post("/login",{username:$("#l-username").value.trim(), password:$("#l-password").value});
  if(!r.ok) return alert(r.error||"Ошибка входа");
  localStorage.token=r.token; await boot();
};

// ====== Theme ======
$("#theme-btn").onclick=()=>{
  const theme = document.body.dataset.theme==="light"?"dark":"light";
  document.body.dataset.theme = theme;
  localStorage.theme = theme;
};
if(localStorage.theme) document.body.dataset.theme = localStorage.theme;

// ====== Boot ======
async function boot(){
  const resp = await API.get("/me");
  if(!resp.ok){ showAuth(true); return; }
  showAuth(false);
  me = resp.user;

  socket = io({query:{token: localStorage.token}});

  // ---- chats / messaging ----
  socket.on("presence", p=>{
    const item = chats.find(c=>c.peer.username===p.username);
    if(item){ item.online = p.online; renderChats(); if(activeChat && activeChat.peer.username===p.username) showPeer(item.peer); }
  });
socket.on("message", msg=>{
  if(activeChat && msg.chat_id===activeChat.chat_id){ 
    appendMsg(msg); 
  }
  loadChats();

  // всегда проигрываем звук прихода
  // (если хочешь — добавь проверку, что чат не активен)
  if(msg.sender !== me.username){
    playSound("receive");
  }
});

// ====== Mobile menu toggle ======
$("#menu-btn").onclick = ()=>{
  $(".left").classList.toggle("show");
};

// Когда пользователь кликает на чат в списке — список закрывается (на мобилке)
document.querySelectorAll(".chat-item").forEach(item=>{
  item.addEventListener("click", ()=>{
    if(window.innerWidth <= 768){
      $(".left").classList.remove("show");
    }
  });
});

  socket.on("typing", e=>{
    if(activeChat && e.chat_id===activeChat.chat_id){
      $("#peer-status").textContent = "печатает…";
      clearTimeout(window._typeTimer);
      window._typeTimer = setTimeout(()=>updatePeerStatus(), 1200);
    }
  });

  // ---- calls wiring ----
  wireCallUI();
  wireCallSocket();

  // ---- settings UI state ----
  $("#notifications-toggle").classList.toggle("active", Settings.notifications);
  $("#sounds-toggle").classList.toggle("active", Settings.sounds);
  $("#auto-media-toggle").classList.toggle("active", Settings.autoMedia);

  $("#notifications-toggle").onclick = e=>{
    Settings.notifications = !Settings.notifications;
    e.currentTarget.classList.toggle("active", Settings.notifications);
    saveSettings();
  };
  $("#sounds-toggle").onclick = e=>{
    Settings.sounds = !Settings.sounds;
    e.currentTarget.classList.toggle("active", Settings.sounds);
    saveSettings();
  };
  $("#auto-media-toggle").onclick = e=>{
    Settings.autoMedia = !Settings.autoMedia;
    e.currentTarget.classList.toggle("active", Settings.autoMedia);
    saveSettings();
  };

  await loadChats();
}

async function loadChats(){
  const r = await API.get("/contacts");
  if(!r.ok) return;
  chats = r.items;
  renderChats();
  if(activeChat){
    const updated = chats.find(c=>c.chat_id===activeChat.chat_id);
    if(updated) activeChat = updated;
  }
}

function renderChats(){
  const list = $("#chats");
  list.innerHTML="";
  chats.forEach(c=>{
    const item = el("div","chat-item"+(activeChat&&activeChat.chat_id===c.chat_id?" active":""));
    const av = el("img","avatar"); 
    av.src = c.peer.avatar_url || "https://i.pravatar.cc/100?u="+c.peer.username;

    const col = el("div","");
    const row1 = el("div","ci-name"); 
    row1.textContent = `${c.peer.first_name||c.peer.username} ${c.peer.last_name||""}`.trim();
    const row2 = el("div","ci-meta"); 
    row2.textContent = (c.online?"В сети":"") || (c.last_text||"");

    const right = el("div","");
    if(c.unread>0){ 
      const b=el("span","badge"); 
      b.textContent=c.unread; 
      right.appendChild(b); 
    }

    col.append(row1,row2);
    item.append(av,col,right);

    // === Главное изменение ===
    item.onclick = ()=>{
      openChat(c);
      if(window.innerWidth <= 768){   // если мобильный
        $(".left").classList.remove("show"); // скрываем список
      }
    };

    list.appendChild(item);
  });
}

function showPeer(peer){
  $("#peer-avatar").src = peer.avatar_url || "https://i.pravatar.cc/100?u="+peer.username;
  $("#peer-name").textContent = `${peer.first_name||peer.username} ${peer.last_name||""}`.trim();
  updatePeerStatus();
}
function updatePeerStatus(){
  if(!activeChat) return;
  $("#peer-status").textContent = activeChat.online ? "в сети" : (activeChat.last_seen? ("был(а) в сети: "+new Date(activeChat.last_seen).toLocaleString()):"");
}

// ====== Open chat & history ======
async function openChat(c){
  activeChat = c;
  renderChats();
  showPeer(c.peer);
  $("#messages").innerHTML="";
  const h = await API.get("/history?chat_id="+c.chat_id);
  if(h.ok){
    h.messages.forEach(appendMsg);
  }
  socket.emit("join_chat",{chat_id:c.chat_id});
}

function appendMsg(m){
  const wrap = el("div","msg "+(m.sender===me.username?"me":"other"));
  if(m.type==="gif"){
    const img = el("img","gif"); img.src = m.text; wrap.appendChild(img);
  }else{
    wrap.textContent = m.text;
  }
  $("#messages").appendChild(wrap);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

// ====== Send text ======
$("#send").onclick = sendText;
$("#msg").addEventListener("keydown", e=>{
  if(e.key==="Enter"){ e.preventDefault(); sendText(); }
  if(activeChat) socket.emit("typing",{chat_id: activeChat.chat_id, me: me.username});
});
async function sendText(){
  if(!activeChat) return;
  const t = $("#msg").value.trim();
  if(!t) return;
  socket.emit("send_message", {token: localStorage.token, chat_id: activeChat.chat_id, type:"text", text: t});
  $("#msg").value="";
  playSound("send");
}

// ====== Add chat (+) ======
$("#add-chat").onclick = async ()=>{
  const username = prompt("Username пользователя:");
  if(!username) return;
  const search = await fetch(`/search_user?username=${encodeURIComponent(username)}`).then(r=>r.json());
  const found = (search.results||[]).find(x=>x.username===username);
  if(!found){ alert("Пользователь не найден"); return; }
  const r = await API.post("/create_chat",{peer: username});
  if(!r.ok){ alert(r.error||"Ошибка"); return; }
  await loadChats();
  const c = chats.find(x=>x.chat_id===r.chat_id);
  if(c) openChat(c);
};

// ====== GIF search/send ======
const gifPanel = $("#gif-panel");
$("#gif-open").onclick=()=> gifPanel.classList.remove("hidden");
$("#gif-close").onclick=()=> gifPanel.classList.add("hidden");
$("#gif-search").onclick=()=> searchGifs();
$("#gif-q").addEventListener("keydown", e=>{ if(e.key==="Enter") searchGifs(); });

async function searchGifs(){
  const q = ($("#gif-q").value || "funny").trim();
  try{
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${window.GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=g`;
    const data = await fetch(url).then(r=>r.json());
    const grid = $("#gif-grid"); grid.innerHTML="";
    (data.data||[]).forEach(g=>{
      const img = document.createElement("img");
      img.src = g.images.fixed_width.url;
      img.title = g.title||"GIF";
      img.onclick = ()=> sendGif(img.src);
      grid.appendChild(img);
    });
  }catch(e){ alert("Ошибка GIPHY"); }
}
function sendGif(src){
  if(!activeChat) return;
  socket.emit("send_message", {token: localStorage.token, chat_id: activeChat.chat_id, type:"gif", text: src});
  gifPanel.classList.add("hidden");
}

// ====== Calls ======
$("#call-voice").onclick=()=> startCall({video:false});
$("#call-video").onclick=()=> startCall({video:true});

const CallState = {
  pc: null,
  localStream: null,
  remoteStream: null,
  peer: null,
  media: "audio",
  timer: null,
  startAt: null,
  screenTrack: null,
};

function wireCallUI(){
  $("#end-call-btn").onclick = endCall;
  $("#mute-btn").onclick = toggleMute;
  $("#video-btn").onclick = toggleVideo;
  $("#screen-btn").onclick = toggleScreen;
  $("#settings-btn").onclick = ()=> $("#settings-modal").style.display="flex";
  $("#close-settings").onclick = ()=> $("#settings-modal").style.display="none";
}

function wireCallSocket(){
  socket.on("call-offer", onCallOffer);
  socket.on("call-answer", async data=>{
    if(!CallState.pc) return;
    await CallState.pc.setRemoteDescription(data.sdp);
    setCallStatus("Соединено");
    startDuration();
    stopRinging();
  });
  socket.on("call-decline", ()=>{
    toast("Звонок отклонён");
    closeCallUI();
    cleanupCall();
  });
  socket.on("call-end", ()=>{
    toast("Звонок завершён");
    closeCallUI();
    cleanupCall();
  });
  socket.on("ice-candidate", async data=>{
    try{ if(CallState.pc) await CallState.pc.addIceCandidate(data.candidate); }catch(e){}
  });
}

async function startCall({video}){
  if(!activeChat) return alert("Выберите чат");
  await openCallUI(activeChat.peer, video?"video":"audio");
  const pc = await createPeer(activeChat.peer.username);
  const offer = await pc.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:video});
  await pc.setLocalDescription(offer);
  playRinging(true);
  socket.emit("call-offer",{to: activeChat.peer.username, from: me.username, sdp: offer, media: video?"video":"audio"});
}

async function onCallOffer(data){
  const peerUsername = data.from;
  const isVideo = data.media === "video";
  $("#incoming-avatar").src = activeChat?.peer?.avatar_url || $("#peer-avatar").src;
  $("#incoming-name").textContent = peerUsername;
  $("#incoming-type").textContent = isVideo? "Входящий видеозвонок" : "Входящий звонок";
  $("#incoming-call").classList.add("show");

  playRinging(false);

  $("#accept-call").onclick = async ()=>{
    $("#incoming-call").classList.remove("show");
    await openCallUI({username: peerUsername}, isVideo?"video":"audio");
    const pc = await createPeer(peerUsername);
    await pc.setRemoteDescription(data.sdp);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit("call-answer",{to: peerUsername, from: me.username, sdp: ans});
    setCallStatus("Соединено");
    startDuration();
    stopRinging();
  };
  $("#decline-call").onclick = ()=>{
    $("#incoming-call").classList.remove("show");
    socket.emit("call-decline",{to: peerUsername});
    stopRinging();
  };
}

async function createPeer(peerUsername){
  CallState.peer = peerUsername;
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  CallState.pc = pc;
  pc.onicecandidate = e=>{ if(e.candidate) socket.emit("ice-candidate",{to: peerUsername, candidate:e.candidate}); };
  pc.onconnectionstatechange = ()=>{
    if(pc.connectionState==="failed" || pc.connectionState==="disconnected"){ toast("Потеряно соединение"); endCall(); }
  };
  pc.ontrack = e=>{
    if(!CallState.remoteStream){ CallState.remoteStream = new MediaStream(); $("#remote-video").srcObject = CallState.remoteStream; }
    e.streams[0].getTracks().forEach(t=> CallState.remoteStream.addTrack(t));
  };
  const needVideo = ($("#call-modal").dataset.media||"audio")==="video";
  const ms = await navigator.mediaDevices.getUserMedia({audio:true, video: needVideo});
  CallState.localStream = ms;
  $("#local-video").srcObject = ms;
  ms.getTracks().forEach(t=> pc.addTrack(t, ms));
  updateAVButtons();
  return pc;
}

function endCall(){
  socket.emit("call-end",{to: CallState.peer});
  closeCallUI();
  cleanupCall();
}

function cleanupCall(){
  stopRinging();
  if(CallState.timer){ clearInterval(CallState.timer); CallState.timer=null; }
  if(CallState.screenTrack){ CallState.screenTrack.stop(); CallState.screenTrack=null; }
  if(CallState.localStream){ CallState.localStream.getTracks().forEach(t=>t.stop()); CallState.localStream=null; }
  if(CallState.remoteStream){ CallState.remoteStream.getTracks().forEach(t=>t.stop()); CallState.remoteStream=null; }
  if(CallState.pc){ try{CallState.pc.close();}catch(e){} CallState.pc=null; }
  CallState.peer=null; CallState.media="audio"; CallState.startAt=null;
  $("#remote-video").srcObject=null;
  $("#local-video").srcObject=null;
}

function openCallUI(peer, media){
  $("#call-peer-name").textContent = peer.username || peer.first_name || "Пользователь";
  $("#call-status").textContent = "Соединение...";
  $("#call-duration").textContent = "00:00";
  $("#call-modal").classList.add("show");
  $("#call-modal").dataset.media = media;
  CallState.media = media;
  updateAVButtons();
  return Promise.resolve();
}

function closeCallUI(){
  $("#call-modal").classList.remove("show");
  $("#screen-share-indicator").classList.remove("show");
}
function setCallStatus(s){ $("#call-status").textContent = s; }
function startDuration(){
  CallState.startAt = Date.now();
  CallState.timer = setInterval(()=>{
    const sec = Math.floor((Date.now()-CallState.startAt)/1000);
    const mm = String(Math.floor(sec/60)).padStart(2,"0");
    const ss = String(sec%60).padStart(2,"0");
    $("#call-duration").textContent = mm+":"+ss;
  }, 1000);
}
function toggleMute(){
  if(!CallState.localStream) return;
  const enabled = CallState.localStream.getAudioTracks().some(t=>t.enabled);
  CallState.localStream.getAudioTracks().forEach(t=> t.enabled = !enabled);
  $("#mute-btn").classList.toggle("off", enabled);
}
function toggleVideo(){
  if(!CallState.localStream) return;
  const tracks = CallState.localStream.getVideoTracks();
  if(tracks.length){
    const enabled = tracks.some(t=>t.enabled);
    tracks.forEach(t=> t.enabled = !enabled);
    $("#video-btn").classList.toggle("off", enabled);
  }
}
async function toggleScreen(){
  if(CallState.screenTrack){
    CallState.screenTrack.stop();
    CallState.screenTrack = null;
    $("#screen-share-indicator").classList.remove("show");
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getDisplayMedia({video:true});
    const track = stream.getVideoTracks()[0];
    CallState.screenTrack = track;
    $("#screen-share-indicator").classList.add("show");
    const sender = CallState.pc.getSenders().find(s=> s.track && s.track.kind==="video");
    if(sender) sender.replaceTrack(track);
    track.onended = ()=>{
      $("#screen-share-indicator").classList.remove("show");
      CallState.screenTrack = null;
      const cam = CallState.localStream?.getVideoTracks?.()[0];
      if(cam && sender) sender.replaceTrack(cam);
    };
  }catch(e){}
}
function updateAVButtons(){
  const v = ($("#call-modal").dataset.media||"audio")==="video";
  $("#video-btn").style.display = v ? "inline-flex":"none";
  $("#screen-btn").style.display = v ? "inline-flex":"none";
}

// ====== Ringing ======
function playRinging(outgoing){
  stopRinging();
  Sounds.call.loop = true;
  Sounds.call.play().catch(()=>{});
}
function stopRinging(){
  try{ Sounds.call.pause(); Sounds.call.currentTime=0; }catch(_){}
}

// ====== Search ======
$("#search").addEventListener("input", async (e)=>{
  const q = e.target.value.trim();
  if(!q){ $("#search-results").innerHTML=""; return; }
  const r = await fetch("/search_user?username="+encodeURIComponent(q)).then(r=>r.json());
  const box = $("#search-results"); box.innerHTML="";
  (r.results||[]).forEach(u=>{
    const div = el("div","chat-item");
    const av = el("img","avatar"); av.src=u.avatar_url||"https://i.pravatar.cc/100?u="+u.username;
    const name = el("div","ci-name"); name.textContent = u.username;
    div.append(av, name);
    div.onclick = async ()=>{
      const cr = await API.post("/create_chat",{peer:u.username});
      if(cr.ok){ await loadChats(); const c = chats.find(x=>x.chat_id===cr.chat_id); if(c) openChat(c); }
      $("#search-results").innerHTML="";
      $("#search").value="";
    };
    box.appendChild(div);
  });
});

// ====== Logout ======
$("#logout").onclick=()=>{ localStorage.removeItem("token"); location.reload(); };

// start
(async ()=>{ if(!localStorage.token){ showAuth(true); } else { await boot(); } })();