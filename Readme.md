
# rtc

  A WebRTC component. Takes care of the handshake fuss and lets you focus on your app.

  1. Connect
  2. Add some listeners
  3. Attach your stream (optional)

## Features

  - Reconnects automatically
  - Re-attaches added streams upon reconnect
  - Really simple signal-servers by using _challenges_ on the client side

## Example

  A minimal example which opens one DataChannel and adds a webcam video stream:

    var rtc = require('rtc');

    // video elements in the DOM
    var localVideo = document.getElementById('local');
    var remoteVideo = document.getElementById('remote');

    // create a connection (defaults to use the app channel signals)
    var remote = rtc.connect({ dataChannels: 'example' });

    // attaches the remote video the the <video>-element.
    remote.on('addstream',function(e){
      remoteVideo.src = URL.createObjectURL(e.stream);
    })

    // 'open' is emitted whenever the connection is established
    // and stable.
    // NOTE: If a stream is added while being open it will close
    // and then re-open when connection is ready again.
    remote.on('open',function(e){
      // you can use `remote.initiator` to differentiate
      // between the two connected peers.
      if( remote.initiator ){
        remote.send('example','hello there from the master')
      } else {
        remote.send('example','hello there from the slave')
      }
    })

    // listen for data channel messages
    remote.on('channel message',function(e){
      console.log('from remote: ',e.data);
    })

    // request webcam access and attach to both
    // the local <video>-element and over WebRTC.
    getUserMedia(function success(stream){
      localVideo.src = URL.createObjectURL(stream)
      remote.addStream(stream);
    })

  For more complete examples look in the [example/]() directory.

## Installation

    $ component install publicclass/rtc

## Test

    $ git clone https://github.com/publicclass/rtc
    $ cd rtc
    $ make build
    $ make test-app-chan # for the app-channel signal (requires go-app-engine-sdk)
    $ make test-ws # for the web socket signal (requires node)

## API

### rtc.servers

  The [RTCConfiguration](http://www.w3.org/TR/webrtc/#idl-def-RTCConfiguration) Dictionary. Defaults to use the Google STUN server but if the `turnConfigURL`-option is set it will be updated when the TURN configuration server responds.

### rtc.available

  Set to `true` if PeerConnection and DataChannel is available. Otherwise `false`.

### rtc.connect([opts]) => Rtc

  Creates an `Rtc`-instance.

  Available options:

  - `dataChannels` - A string or array of labels of channels to add to the PeerConnection. Defaults to `false`, no data channels.
  - `connectionTimeout` - The time, in milliseconds, it will wait during connection until considered it timed out.
  - `turnConfigURL` - A URL to a TURN configuration server. Defaults to `''`, no server.
  - `autoNegotiate` - A boolean which controls if the Rtc connection should automatically renegotiate when a stream has been added or removed. Defaults to `true`.
  - `signal` - A string to decide which type of signal to create. If set to `ws` it will use the `WebSocketSignal`, otherwise the `AppChannelSignal`.

  The rest of the `opts` will be passed into the Signal (see Rtc#signal below).

### Rtc#addStream(stream,constraints)

  Adds, and maintains, a stream on the `Rtc`-instance. Will be re-added upon reconnection.

### Rtc#removeStream(stream)

  Removes a stream from the `Rtc`-instance.

### Rtc#reconnect()

  Recreates the `PeerConnection`, the `DataChannels` and then re-attaches any missing streams. Should not be necessary but useful while testing.

### Rtc#close([keepSignal])

  Closes the underlying `PeerConnection` and all its `DataChannels`. If `keepSignal` is set to `true` it will not close the signal but leave it on, ready for new connections.

### Rtc#signal

  Either a `WebSocketSignal`-instance or an `AppChannelSignal`-instance depending on the `opts` passed into `rtc.connect()`.

  `WebSocketSignal()`:
  - `url` - The URL to the WebSocket relay.
  - `timeout` - A time, in milliseconds, that it will attempt to connect before timing out.
  - `retryTimeout` - A time, in milliseconds, that it will attempt to reconnect before timing out.
  - `maxAttempts` - The number of retries it will attempt before giving up.

  `AppChannelSignal()`:
  - `room` - A room name to connect to.
  - `timeout` - A time, in milliseconds, that it will attempt to connect before timing out.
  - `retryTimeout` - A time, in milliseconds, that it will attemp to reconnect before timing out.
  - `maxAttempts` - The number of retries it will attempt before giving up.
  - `bufferCandidates` - If `true` it will buffer all ice candidates and send them all at once. This is useful when running the AppEngine SDK because each request can take up to a second and if there's a lot of ice candidates this will speed it up significantly.

#### Events

  - `connected` is emitted when two peers are connected to the same room.
  - `disconnected` is emitted when one peer has left the room.
  - `reconnect` is emitted when Rtc has reconnected.
  - `open` is emitted when the `rtc.open` is set to true. That is when the connection handshake is complete, the candidates are gathered and the connection is considered stable.
  - `close` is emitted when `rtc.open` has been changed from true to false. This happens when a stream has been added or removed and the connection is renegotiated.
  - `full` is emitted when the room already has two peers.
  - `token` (AppChannelSignal only) is emitted when the signal has received a `token` and `username` from the server.
  - `error` is emitted in the case of a signalling error.

  The [DataChannel events](http://www.w3.org/TR/webrtc/#event-summary) are emitted on teh `Rtc`-instance but prefixed by 'channel' and 'channel {label}'.

  - `channel message`, `channel {label} message` is emitted when a message has been received.
  - `channel open`, `channel {label} open` is emitted when a channel has opened.
  - `channel close`, `channel {label} close` is emitted when a channel has closed.
  - `channel error`, `channel {label} error` is emitted when a channel has errored.

  Then also the [PeerConnection events](http://www.w3.org/TR/webrtc/#event-summary) are emitted on the `Rtc`-instance:

  - `icechange`
  - `statechange`
  - `gatheringchange`
  - `datachannel`
  - `addstream`
  - `removestream`
  - `icecandidate`
  - `negotiationneeded`

### Signal#send(msg)

  Sends a message over the signal connection. If `msg` is a string it will be converted to a custom event. Otherwise it will be JSON stringified first. If `Signal#send()` has been called before the signal connection has been opened it will be sent when opened.

#### Events (used internally)

  - `error` is emitted when the signal connection emits an error.
  - `open` is emitted when the signal connection has been opened. This is when the initial PeerConnections is created in Rtc.
  - `offer` is emitted when an offer has been received from the peer over the signal.
  - `answer` is emitted when an answer has been received from the peer over the signal.
  - `close` is emitted when the peer or server has requested the connection to close.
  - `request-for-offer` is emitted when the peer requests an offer.
  - `candidate` is emitted when a peer has send an ice candidate.
  - `connected` is emitted when two peers are connected to the same room.
  - `disconnected` is emitted when one peer has left the room.
  - `challenge` is emitted either when a challenge has been requested from peer (when null) or when a challenge has been received from peer.
  - `event` is emitted for custom events to be re-emitted by Rtc.


## License

  MIT
