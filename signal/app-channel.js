/* globals goog: true */
var Emitter = require('emitter')
  , debug = require('debug')('rtc:signal:appchan');


module.exports = AppChannel;

/**
 * The AppChannel uses an App Engine channel.
 */
function AppChannel(opts){
  opts = opts || {};
  opts.token = opts.token || '';
  opts.room = opts.room || '';
  opts.user = opts.user || '';
  opts.timeout = opts.timeout || 15000;
  opts.retryTimeout = opts.retryTimeout || 5000;
  opts.maxAttempts = opts.maxAttempts || 5;
  opts.bufferCandidates = opts.bufferCandidates || false;

  var retryTimeout = opts.retryTimeout;
  var retryAttempts = 0;
  var signal = Emitter({});

  // default to queue send()
  signal.send = function(msg){
    signal.on('open',function(){
      signal.send(msg)
    })
  }

  // for when the app channel api failed to load
  if( typeof goog == 'undefined' ){
    return signal;
  }

  // token is required and will be empty
  // when quota is full (see error log on server)
  if( !opts.token ){
    var req = new XMLHttpRequest()
    req.onload = function(){
      if( req.readyState == 4 && req.status == 200 ){
        var q = qs(req.responseText);
        opts.user = q.user;
        opts.token = q.token;
        if( opts.user && opts.token ){
          q.type = 'token';
          signal.emit('event',q)
          create()
        }
      }
    };
    req.open('POST', '/_token?room='+opts.room, true)
    req.send()
    return signal;
  }

  function create(){
    debug('create',opts.token,opts.room,opts.user)

    retryTimeout *= 2;
    retryAttempts++;
    if( retryAttempts >= opts.maxAttempts ){
      return signal.emit('error',new Error('unable to connect to signal: '+opts.token))
    }

    var channel = new goog.appengine.Channel(opts.token)
      , socket = channel.open()
      , connected = null
      , opened = false
      , candidates = [];

    socket.onopen = function(){
      debug('open')
      opened = true;

      // Make sure server knows we connected.
      // (a workaround for unreliable, and sometimes
      // totally non-functioning, presence service
      // in google appengine)
      var req = new XMLHttpRequest()
      req.open('POST', '/_connect?from='+opts.user+'-'+opts.room, false)
      req.send()

      signal.emit('open') // create the peer connection here
      clearTimeout(socket.timeout)
    }

    socket.onmessage = function(m){
      // reset retry timeout on first message
      retryTimeout = opts.retryTimeout;
      retryAttempts = 0;

      if( m.data == 'connected' ){
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
        console.warn('received messages from channel before being connected. ignoring.',m.data)
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
    }

    socket.onerror = function(e){
      console.error('Socket error: ',e)
      signal.emit('error', e)
      close()
    }

    socket.onclose = function(){
      // TODO emit "close" only after a few attempts
      //      and possible "reconnected" if retries
      //      work...
      debug('closed (retrying in %sms)',retryTimeout)
      clearTimeout(socket.timeout)
      socket.timeout = setTimeout(create,retryTimeout)
    }

    clearTimeout(socket.timeout)
    socket.timeout = setTimeout(function(e){
      debug('timed out (retrying in %sms)',retryTimeout)
      clearTimeout(socket.timeout)
      socket.timeout = setTimeout(create,retryTimeout)
    },opts.timeout)

    signal.send = function(msg){
      debug('send',msg)
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
        var req = new XMLHttpRequest()
        req.onerror = function(e){
          // socket.onerror(e)
          console.error('error while sending app-channel-message (retrying)',e)
          setTimeout(function(){
            signal.send(originalMessage);
          },100)
        }
        req.open('POST', '/_message?from='+opts.user+'-'+opts.room, true)
        req.setRequestHeader('Content-Type','application/json')
        req.send(msg)
      } else {
        console.error('attempted to send a message too early, waiting for open')
        signal.on('open',signal.send.bind(signal,originalMessage))
      }
    }

    // ensure the room is disconnect on leave
    var _before = window.onbeforeunload;
    window.onbeforeunload = function(){
      if( connected ){
        try {
          var req = new XMLHttpRequest()
          req.open('POST', '/_disconnect?from='+opts.user+'-'+opts.room, false)
          req.send()
        } catch(e){
          // ignored because it should be done from the
          // backend anyway
        }
      }

      // chain in case there's other listeners
      if( typeof _before == 'function' ){
        _before.apply(window,arguments);
      }
    }


    function close(){
      debug('close')

      clearTimeout(socket.timeout)
      // socket.close(); // will this throw?
      signal.emit('close')

      // re-connect if were connected
      if( connected ){
        connected = false;
        signal.emit('disconnected')
        socket.timeout = setTimeout(create,retryTimeout)
      }
    }

    return signal;
  }
  return create();
}

function qs(query){
  var obj = {};
  var vars = query.split('&');
  for (var i = 0; i < vars.length; i++) {
    var pair = vars[i].split('=')
      , key = decodeURIComponent(pair[0])
      , val = decodeURIComponent(pair[1]);
    obj[key] = val;
  }
  return obj;
}