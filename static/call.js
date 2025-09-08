// call.js - простой заглушечный клиент: получает media и показывает локальное видео.
// Для полноценного звонка нужен signaling (socket или сервер), тут — только UI/локальное видео.

(async ()=>{
  const params = new URLSearchParams(location.search);
  const peer = params.get('peer');
  const type = params.get('type') || 'audio';
  document.getElementById('title').textContent = (type==='video' ? 'Видеозвонок с ' : 'Аудиозвонок с ') + peer;

  try {
    const constraints = type==='video' ? { audio:true, video:true } : { audio:true, video:false };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const local = document.getElementById('local');
    local.srcObject = stream;
    // NOTE: for a real call we need to create RTCPeerConnection, exchange SDP/ICE over signaling server
    // For now this window just shows your local media; later we'll connect it to the other peer.
  } catch(err){
    alert('Ошибка доступа к микрофону/камере: '+err.message);
  }

  document.getElementById('btn-hang').onclick = ()=> window.close();
})();
