var Emitter = require('emitter')
  , debug = require('debug')('rtc:signal:ws');


module.exports = WebSocketSignal;

/**
 * The WebSocketSignal expects to connect
 * to a simple relay server.
 *
 * ex: https://gist.github.com/4547040#file-relay-js
 */
function WebSocketSignal(opts){
  opts = opts || {};
  opts.url = opts.url || 'ws://localhost:8080/test';
  opts.timeout = opts.timeout || 5000;
  opts.retryTimeout = opts.retryTimeout || 500;
  opts.maxAttempts = opts.maxAttempts || 5;

  var retryTimeout = opts.retryTimeout;
  var retryAttempts = 0;
  var signal = Emitter({});

  function create(){
    debug('create')

    retryTimeout *= 2;
    retryAttempts++;
    if( retryAttempts >= opts.maxAttempts ){
      return signal.emit('error',new Error('unable to connect to signal: '+opts.url))
    }

    var ws = new WebSocket(opts.url)
      , connected = null;

    ws.onopen = function(){
      debug('open')
      signal.emit('open') // create the peer connection here
      clearTimeout(ws.timeout)
    }

    ws.onmessage = function(m){
      // reset retry timeout on first message
      retryTimeout = opts.retryTimeout;
      retryAttempts = 0;

      var json = JSON.parse(m.data);
      if( json && json.type == 'offer' ){
        debug('offer',json)
        signal.emit('offer',new RTCSessionDescription(json))

      } else if( json && json.type == 'request-for-offer' ){
        debug('request-for-offer')
        signal.emit('request-for-offer')

      } else if( json && json.type == 'answer' ){
        debug('answer',json)
        signal.emit('answer',new RTCSessionDescription(json))

      } else if( json && json.type == 'close' ){
        debug('close')
        signal.emit('close');
        if( connected === true ){
          connected = false;
          debug('disconnected')
          signal.emit('disconnected') // from peer
        }

      } else if( json && json.candidates ){
        debug('candidates',[json])
        for( var i=0; i<json.candidates.length; i++ ){
          signal.emit('candidate',new RTCIceCandidate(json.candidates[i]))
        }

      } else if( json && json.candidate ){
        debug('candidate',[json])
        signal.emit('candidate',new RTCIceCandidate(json))

      } else if( json && json.a && json.b ){
        if( !connected ){
          connected = true;
          debug('connected')
          signal.emit('connected') // from peer
        }

      } else if( json && ((json.a && !json.b) || (json.b && !json.a)) ){
        if( connected === true ){
          connected = false;
          debug('disconnected')
          signal.emit('disconnected') // from peer
        }

      } else if( json && 'challenge' in json ){
        debug('challenge',[json])
        signal.emit('challenge',json)

      } else if( json ){
        debug('message',m.data)
        if( json.type ){
          signal.emit('event',json)
        }
      } else {
        console.warn('invalid json',json)
      }
    }

    ws.onerror = function(e){
      console.error('WS error: ',e)
      clearTimeout(ws.timeout)
      signal.emit('close')
      signal.emit('error',e)
    }

    ws.onclose = function(e){
      // if we weren't connected and the socket
      // was closed normally (code 1000) then the
      // room is most likely full.
      if( e.code === 1000 && connected === null ){
        debug('closed (probably full)',e.code)
        signal.emit('event',{type:'full'})

      // if not it's probably a network error and
      // we should retry a few times.
      } else {
        debug('closed (retrying in %sms)',retryTimeout)
        signal.emit('close')
        clearTimeout(ws.timeout)
        ws.timeout = setTimeout(create,retryTimeout)
      }
    }

    clearTimeout(ws.timeout)
    ws.timeout = setTimeout(function(e){
      debug('timed out (retrying in %sms)',retryTimeout)
      clearTimeout(ws.timeout)
      ws.timeout = setTimeout(create,retryTimeout)
    },opts.timeout)

    signal.send = function(msg){
      debug('send',msg)
      if( ws.readyState == ws.OPEN ){
        if( typeof msg == 'string' ){
          msg = JSON.stringify({type:msg});
        } else {
          msg = JSON.stringify(msg)
        }
        ws.send(msg)
      } else {
        console.warn('attempted to send a message too early, waiting for open')
        signal.on('open',signal.send.bind(signal,msg))
      }
    }

    return signal;
  }
  return create();
}