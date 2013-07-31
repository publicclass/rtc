var Emitter = require('emitter')
  , debug = require('debug')('rtc:signal:bridge');


module.exports = BridgeSignal;

/**
 * The AppChannel uses an App Engine channel through a WebView or IFrame.
 */
function BridgeSignal(opts){
  opts = opts || {};
  opts.root = opts.root || window.location.origin;
  opts.room = opts.room || '';
  opts.timeout = opts.timeout || 15000;
  opts.retryTimeout = opts.retryTimeout || 5000;
  opts.maxAttempts = opts.maxAttempts || 5;
  opts.bufferCandidates = opts.bufferCandidates || false;

  var retryTimeout = opts.retryTimeout;
  var retryAttempts = 0;
  var signal = Emitter({});
  var element = createElement(opts.root + '/' + opts.room,create);

  // default to queue send()
  signal.send = function(msg){
    signal.on('open',function(){
      signal.send(msg)
    })
  }

  function create(){
    var connected = null
      , opened = false
      , candidates = [];

    // listen to element 'message' event
    window.addEventListener('message',function(e){
      // validate the e.origin
      if( opts.root !== e.origin ){
        console.error('invalid bridge message origin')
        return;
      }

      var m = e.data[0];

      if( m == 'pong' ){
        // now we know we are connected
        // (nothing to be done, just bridge internal)
        return;

      } else if( m == 'open' ){
        // emit open
        opened = true;
        signal.emit('open')

      } else if( m == 'error' ){
        signal.emit('error',e.data[1]);

      } else if( m.data == 'connected' ){
        if( !connected ){
          connected = true;
          debug('connected')
          signal.emit('connected') // from peer
        }

      } else if( m.data == 'disconnected' ){
        if( connected === true ){
          connected = false;
          debug('disconnected')
          signal.emit('disconnected') // from peer
        }

      } else if( m.data == 'full' ){
        debug('full')
        signal.emit('event',{type:'full'})
        close()

      } else if( !connected ){
        console.warn('received messages from channel before being connected. ignoring.',m.data, e.data)
        return;

      } else {
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

        } else if( json && 'challenge' in json ){
          debug('challenge',[json])
          signal.emit('challenge',json)

        } else if( json && json.candidates ){
          debug('candidates',[json])
          if( connected === true ){
            for( var i=0; i<json.candidates.length; i++ ){
              signal.emit('candidate',new RTCIceCandidate(json.candidates[i]))
            }
          }

        } else if( json && json.candidate ){
          debug('candidate',[json])
          if( connected === true ){
            signal.emit('candidate',new RTCIceCandidate(json))
          }

        } else if( json ){
          debug('message',m.data)
          if( json.type ){
            signal.emit('event',json)
          }
        } else {
          console.warn('invalid json',json)
        }
      }
    });

    // overwrite signal.send to use element.postMessage()
    signal.send = function(msg){
      var originalMessage = msg;
      if( opened ){
        // an event
        if( typeof msg == 'string' ){
          msg = JSON.stringify({type:msg});

        // received a candidate (to buffer)
        } else if( 'candidate' in msg && opts.bufferCandidates ){
          if( msg.candidate ){
            candidates.push(msg);
            return;

          // end of candidates (= null)
          } else {
            msg = JSON.stringify({candidates:candidates})
          }

        // any other object to send
        } else {
          msg = JSON.stringify(msg)
        }
        element.contentWindow.postMessage({message: msg},opts.root);
      } else {
        console.error('attempted to send a message too early, waiting for open')
        signal.on('open',signal.send.bind(signal,originalMessage))
      }
    }

    // send an initial 'ping' message to establish
    // the source and origin
    try {
      element.contentWindow.postMessage('ping',opts.root);
    } catch(e){
      signal.emit('error',e);
    }
  }

  return signal;
}

function createElement(src,fn){
  // iframe for web, webview for app
  var type = 'iframe';
  try { window.localStorage } // will fail in a packaged app
  catch(e){ type = 'webview' }
  var element = document.createElement(type);
  element.src = src;
  element.seamless = true;
  element.allowtransparency = true;
  element.frameBorder = '0';
  element.scrolling = 'no';
  element.width = 0;
  element.height = 0;
  element.style.width = '0px';
  element.style.height = '0px';
  element.style.display = 'none';

  if( type == 'iframe' ){
    // TODO also check for errors line onerror
    element.onload = fn;
  } else {
    // TODO also check for errors like loadabort or unresponsive?
    element.addEventListener('loadstop',fn);
  }

  document.body.appendChild(element);

  return element;
}
