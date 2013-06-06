var Emitter = require('emitter')
  , WebSocketSignal = require('./signal/web-socket')
  , AppChannelSignal = require('./signal/app-channel')
  , debug = { connection: require('debug')('rtc:connection'),
              channel: require('debug')('rtc:channel') };

// Fallbacks for vendor-specific variables until the spec is finalized.
var PeerConnection = window.webkitRTCPeerConnection
                  || window.mozRTCPeerConnection
                  || window.RTCPeerConnection;

exports.sdpConstraints = {'mandatory': {
                          'OfferToReceiveAudio': true,
                          'OfferToReceiveVideo': true }};

exports.servers = { iceServers: [
  {url: 'stun:stun.l.google.com:19302'}
]}

exports.available = (function(){
  if( typeof PeerConnection == 'function'
      && PeerConnection.prototype // stupid mozilla
      && typeof PeerConnection.prototype.createDataChannel == 'function' ){
    try {
      var pc = new PeerConnection(null,{optional: [{RtpDataChannels: true}]});
      pc.createDataChannel('feat',{reliable:false}).close()
      return true;
    } catch(e){
      return false;
    }
  } else {
    return false;
  }
})();

exports.connect = function(opts){
  opts = opts || {};
  opts.dataChannels = opts.dataChannels || false;
  opts.connectionTimeout = opts.connectionTimeout || 30000;
  opts.turnConfigURL = opts.turnConfigURL || '';
  opts.autoNegotiate = typeof opts.autoNegotiate == 'boolean' ? opts.autoNegotiate : true;

  var rtc = Emitter({})
    , channels = rtc.channels = {}
    , connection
    , signal
    , timeout
    , challenge = Date.now() + Math.random()
    , challenged = rtc.challenged = false
    , challenger = rtc.challenger = false
    , initiator = rtc.initiator = null
    , negotiationneeded = false
    , streams = []
    , open = rtc.open = false;

  // default to appchannel signal
  if( opts.signal == 'ws' ){
    signal = rtc.signal = new WebSocketSignal(opts)
  } else {
    signal = rtc.signal = new AppChannelSignal(opts)
  }

  signal.on('open',function(){
    if( connection ){ rtc.close() }
    connection = createConnection();
    createDataChannels();
    addMissingStreams(connection);
  })
  signal.on('offer',function(desc){
    if( !connection ){ return; }
    debug.connection('remote offer',connection.signalingState,[desc])
    if( connection.signalingState == 'stable' ){
      connection.setRemoteDescription(rewriteSDP(desc),function(){
        debug.connection('create answer')
        connection.createAnswer(onLocalDescriptionAndSend,null,exports.sdpConstraints);
      },onDescError('remote offer'));
    } else {
      debug.connection('received remote "offer" bit expected an "answer"')
    }
  })
  signal.on('answer',function(desc){
    if( !connection ){ return; }
    debug.connection('remote answer',connection.signalingState,[desc])
    if( connection.signalingState != 'stable' ){
      connection.setRemoteDescription(rewriteSDP(desc),function(){},onDescError('remote answer'));
    } else {
      debug.connection('received "answer" but expected an "offer"')
    }
  })
  signal.on('candidate',function(candidate){
    if( !connection ){ return; }

    // skip while disconnected
    if( connection.iceConnectionState == 'disconnected' ){
      return;
    }
    try {
      debug.connection('signal icecandidate',arguments)
      connection.addIceCandidate(candidate);
    } catch(e){
      console.warn('failed to add ice candidate. was it received from a previous connection?',e)
    }
  })
  signal.on('request-for-offer',function(e){
    debug.connection('signal request-for-offer')
    sendOffer()
  })
  signal.on('challenge',function(e){
    // a request-for-challenge
    if( e.challenge === null ){
      debug.connection('request-for-challenge',challenge)
      sendChallenge()
      return;
    }

    // in case a challenge was received without
    // having sent one we send it now.
    if( !challenger ){
      sendChallenge()
    }

    // the one with the lowest challenge
    // (and thus the first one to arrive)
    // is the initiator.
    // and the initiator will "start" the
    // rtc connection by sending the initial
    // offer. the rest of the handshake will
    // be dealt with by the library.
    debug.connection('challenge',challenge,e.challenge)
    if( e.challenge > challenge ){
      rtc.initiator = initiator = true;
      sendOffer();
    } else {
      rtc.initiator = initiator = false;
    }

    // mark this connection as challenged
    // (a requirement to be considered "open")
    rtc.challenged = challenged = true;

    rtc.emit('connected')
  })
  signal.on('connected',function(){
    debug.connection('signal connected')

    // instead of letting a server decide
    // which peer should send the initial
    // offer (aka "initiator") we request
    // the peer to send us a challenge
    requestChallenge()
  })
  signal.on('disconnected',function(){
    debug.connection('signal disconnected')
    rtc.emit('disconnected')
    rtc.reconnect()
  })
  signal.on('event',function(evt){
    var type = evt.type;
    delete evt.type;
    rtc.emit(type,evt);
  })
  signal.on('error',function(evt){
    rtc.emit('error',evt)
  })

  function createConnection(){
    debug.connection('create')

    // clear any previous timeouts
    stopTimeout('create');

    var config = {optional: [{RtpDataChannels: !!opts.dataChannels}]};
    var connection = new PeerConnection(exports.servers,config);
    connection.onconnecting = function(e){
      debug.connection('connecting',arguments)
      rtc.emit('connecting',e)
    }
    connection.onclose = function(e){
      debug.connection('close',arguments)
      rtc.emit('close',e)
      stopTimeout('onclose');
      checkOpen()
    }
    connection.onaddstream = function(e){
      debug.connection('addstream',arguments)
      rtc.emit('addstream',e)
    }
    connection.onremovestream = function(e){
      debug.connection('removestream',arguments)
      rtc.emit('removestream',e)
    }
    connection.ondatachannel = function(e){
      debug.connection('datachannel',arguments)
      channels[e.channel.label] = initDataChannel(e.channel);
      rtc.emit('datachannel',e)
    }
    connection.ongatheringchange = function(e){
      debug.connection('gatheringchange -> %s',connection.iceGatheringState,arguments)
      rtc.emit('gatheringchange',e)
      checkOpen()
    }
    connection.onicecandidate = function(e){
      if( e.candidate ){
        // debug.connection('icecandidate %s',opts.bufferCandidates ? '(buffered)' : '',arguments)
        signal.send(e.candidate)
      } else {
        debug.connection('icecandidate end %s',opts.bufferCandidates ? '(buffered)' : '')
        signal.send({candidate:null})
      }
      rtc.emit('icecandidate',e)
      checkOpen()
    }
    connection.oniceconnectionstatechange =
    connection.onicechange = function(e){
      debug.connection('icechange -> %s',connection.iceConnectionState,arguments)
      rtc.emit('icechange',e)
      checkOpen()
    }
    connection.onnegotiationneeded = function(e){
      debug.connection('negotiationneeded',arguments)
      rtc.emit('negotiationneeded',e)
      if( opts.autoNegotiate ){
        if( open ){
          rtc.offer()
        } else {
          negotiationneeded = true;
        }
      }
    }
    connection.onsignalingstatechange =
    connection.onstatechange = function(e){
      debug.connection('statechange -> %s',connection.signalingState,arguments)
      rtc.emit('statechange',e)
      checkOpen()
    }

    rtc.connection = connection;
    return connection;
  }

  function checkOpen(){
    var isOpen = connection && challenged && challenger &&
      initiator !== null &&
      connection.signalingState == 'stable' &&
      connection.iceConnectionState != 'disconnected' &&
      (connection.iceConnectionState == 'connected' ||
        connection.iceGatheringState == 'complete');

    // closed -> open
    if( !open && isOpen ){
      debug.connection('CLOSED -> OPEN')
      stopTimeout('isopen');
      rtc.open = open = true;
      rtc.emit('open')
      addMissingStreams(connection);

      if( negotiationneeded ){
        debug.connection('negotiationneeded on open')
        rtc.offer()
      }

    // closed -> closed
    } else if( !open && !isOpen ){
      debug.connection('CLOSED -> CLOSED')
      startTimeout('isopen')

    // open -> closed
    } else if( open && !isOpen ){
      debug.connection('OPEN -> CLOSED')
      rtc.open = open = false;
      stopTimeout('isopen');
      rtc.emit('close')

    // open -> open
    } else {
      debug.connection('OPEN -> OPEN')
    }
  }

  function createDataChannels() {
    if( opts.dataChannels ){
      var labels = typeof opts.dataChannels == 'string' ?
        [opts.dataChannels] :
         opts.dataChannels;
      for(var i=0; i<labels.length; i++){
        createDataChannel(labels[i]);
      }
    }
  }

  function createDataChannel(label){
    debug.channel('create',label);
    var channel;
    try {
      // Reliable Data Channels not yet supported in Chrome
      // Data Channel api supported from Chrome M25.
      // You need to start chrome with  --enable-data-channels flag.
      channel = connection.createDataChannel(label,{reliable: false});
    } catch (e) {
      console.error('Create Data channel failed with exception: ' + e.message);
      return null;
    }
    channels[label] = initDataChannel(channel);
    return channel;
  }

  function addMissingStreams(connection){
    // re-add any missing streams
    // [stream,constraints...]
    for(var i=0; i<streams.length; i+=2){
      var stream = streams[i];
      if( !getStreamById(connection,stream.id) ){
        debug.connection('re-added missing stream',stream.id)
        connection.addStream(stream);
      }
    }
  }

  // a fallback version of connection.getStreamById
  function getStreamById(connection,id){
    if( typeof connection.getStreamById == 'function' ){
      return connection.getStreamById(id);
    } else {
      var streams = connection.localStreams || connection.getLocalStreams();
      for(var i=0; i<streams.length; i++){
        if( streams[i].id === id ){
          return streams[i];
        }
      }
      return null;
    }
  }

  function closeDataChannel(label){
    var channel = channels[label];
    if( channel ){
      if( channel.readyState != 'closed' ){
        channel.close();
      }
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      delete channels[label];
    }
  }

  function closeConnection(){
    if( connection ){
      stopTimeout('close')
      if( connection.signalingState != 'closed' ){
        connection.close()
      }
      connection.onconnecting = null;
      connection.onopen = null;
      connection.onclose = null;
      connection.onaddstream = null;
      connection.onremovestream = null;
      connection.ondatachannel = null;
      connection.ongatheringchange = null;
      connection.onicecandidate = null;
      connection.onicechange = null;
      connection.onidentityresult = null;
      connection.onnegotiationneeded = null;
      connection.oniceconnectionstatechange = null;
      connection.onsignalingstatechange = null;
      connection.onstatechange = null;
      connection = null;
    }
    rtc.connection = null;
  }

  function initDataChannel(channel){
    if( channel ){
      debug.channel('adding listeners',channel.label)
      channel.onmessage = function(e){
        debug.channel('message %s',channel.label,e)
        rtc.emit('channel '+channel.label+' message',e)
        rtc.emit('channel message',e)
      }
      channel.onopen = function(e){
        debug.channel('open %s',channel.label)
        rtc.emit('channel '+channel.label+' open',e)
        rtc.emit('channel open',e)
      }
      channel.onclose = function(e){
        debug.channel('close %s',channel.label)
        rtc.emit('channel '+channel.label+' close',e)
        rtc.emit('channel close',e)
      }
      channel.onerror = function(e){
        debug.channel('error %s',channel.label,e)
        rtc.emit('channel '+channel.label+' error',e)
        rtc.emit('channel error',e)
        rtc.emit('error',e)
      }
    }
    return channel;
  }

  var startTimeout = function(from){
    debug.connection('timeout started',from)
    clearTimeout(timeout);
    timeout = setTimeout(function(){
      rtc.emit('timeout');
    },opts.connectionTimeout)
  }

  var stopTimeout = function(from){
    if( timeout ){
      debug.connection('timeout stopped',from)
      clearTimeout(timeout);
      timeout = null;
    }
  }

  var sendOffer = function(){
    if( connection ){
      debug.connection('send offer',connection.signalingState)
      if( connection.signalingState != 'have-remote-offer' ){
        connection.createOffer(onLocalDescriptionAndSend,null,exports.sdpConstraints);
      } else {
        debug.connection('offer not sent because of signalingState',connection.signalingState)
      }
      negotiationneeded = false;
    }
  }

  var sendChallenge = function(){
    debug.connection('send challenge',challenge)
    signal.send({challenge:challenge})
    rtc.challenger = challenger = true;
  }

  var requestOffer = function(){
    if( connection ){
      debug.connection('request offer')
      signal.send({type:'request-for-offer'})
      negotiationneeded = false;
    }
  }

  var requestChallenge = function(){
    debug.connection('request challenge')
    signal.send({challenge:null})
  }

  var onDescError = function(src){
    return function(err){
      if( connection ){
        console.log('signalingState',connection.signalingState)
        console.log('iceConnectionState',connection.iceConnectionState)
        console.log('iceGatheringState',connection.iceGatheringState)
      }
      console.warn('could not set %s description',src,err)
    }
  }

  var onLocalDescriptionAndSend = function(desc){
    debug.connection('local description',desc)
    if( connection ){
      connection.setLocalDescription(desc,function(){},onDescError('local '+desc.type))
      signal.send(desc)
    }
  }

  rtc.offer = function(){
    if( initiator === true ){
      sendOffer()
    } else if( initiator === false ){
      requestOffer()
    } else {
      console.warn('attempting to offer before open')
    }
  }

  rtc.addStream = function(stream,constraints){
    debug.connection('adding local stream')
    try {
      connection && connection.addStream(stream,constraints);
      streams.push(stream,constraints);
    } catch(e){}
    return this;
  }

  rtc.removeStream = function(stream){
    debug.connection('removing local stream')
    var i = streams.indexOf(stream);
    ~i && streams.splice(i,2);
    connection && connection.removeStream(stream);
    return this;
  }

  rtc.reconnect = function(){
    debug.connection('reconnect')
    if( connection ) {
      rtc.close(true)
    }
    connection = createConnection();
    createDataChannels();
    requestChallenge();
    rtc.emit('reconnect')
    return this;
  }

  rtc.close = function(keepSignal){
    debug.connection('close')
    var labels = Object.keys(channels);
    labels.forEach(closeDataChannel)
    closeConnection()
    rtc.challenged = challenged = false;
    rtc.challenger = challenger = false;
    rtc.initiator = initiator = null;
    checkOpen()
    keepSignal || signal.send('close')
  }

  rtc.send = function(label,data){
    debug.channel('send',label,data)
    var channel = channels[label];
    if( channel ){
      if( channel.readyState == 'open' ){
        channel.send(data);
      } else {
        console.warn('tried to send data on a not open channel %s',label)
      }
    } else {
      console.error('tried to send to non-existing channel %s',label);
    }
  }

  // ensure we close properly before
  // unload. (hoping this will lessen
  // the "Aw snap" errors)
  var _before = window.onbeforeunload;
  window.onbeforeunload = function() {
    stopTimeout('unload');
    rtc.close();

    // chain in case there's other listeners
    if( typeof _before == 'function' ){
      _before.apply(window,arguments);
    }
  }

  // request optional turn configuration
  if( opts.turnConfigURL ){
    requestTURNConfiguration(opts.turnConfigURL,rtc);
  }

  return rtc;
}


function rewriteSDP(desc){
  // adjust the bandwidth to 64kbps instead of default 30kbps
  desc.sdp = desc.sdp.replace('b=AS:30','b=AS:64')
  return desc;
}

// 'http://computeengineondemand.appspot.com/turn?username=apa&key=1329412323'
function requestTURNConfiguration(url,rtc){
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function(){
    if( xhr.readyState == 4 && xhr.status == 200 ){
      var data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch(e) {
        return debug.connection('got bad data from turn ajax service.',xhr.responseText);
      }
      if( data.uris && data.uris[0] && data.username && data.password ){
        for (var i = 0; i < data.uris.length; i++) {
          exports.servers.iceServers.push({
            url: data.uris[i].replace(':', ':' + data.username + '@'),
            credential: data.password
          })
        }

        // attempt a reconnect using the new configuration
        rtc && rtc.reconnect()
      }
    }
  }
  xhr.open('GET', url, true);
  xhr.send();
}
