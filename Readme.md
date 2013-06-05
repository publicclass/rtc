
# rtc

  A WebRTC component.

## Installation

    $ component install publicclass/rtc

## Test

    $ make build
    $ make test-app-chan # for the app-channel signal (requires go-app-engine-sdk)
    $ make test-ws # for the web socket signal (requires node)

## API

TODO

### rtc.servers

### rtc.available

### rtc.connect([opts]) => Rtc

### Rtc#addStream(stream,constraints)

### Rtc#removeStream(stream)

### Rtc#start()

### Rtc#reconnect()

### Rtc#close()

### Rtc#signal

#### Events

- `connected` is emitted when two peers are connected to the same room.
- `disconnected` is emitted when one peer has left the room.
- `open` is emitted
- `full`

### Signal#send(msg)

#### Events


## License

  MIT
