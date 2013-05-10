// the server code for relaying signal messages between 2 peers
// in the same room.
//
// to use:
//   npm i ws
//   node relay.js

var WebSocketServer = require('ws').Server
  , parse = require('url').parse
  , wss = new WebSocketServer({port: 8090});

var rooms = {};

wss.on('connection',function(ws){
  var url = parse(ws.upgradeReq.url)
    , name = url.pathname.slice(1)
    , room = rooms[name] || (rooms[name] = {a:null,b:null});

  if( !room.a ){
    console.log('connected a@%s', name)
    room.a = ws;
  } else if( !room.b ) {
    console.log('connected b@%s', name)
    room.b = ws;
  } else {
    console.log('closing c@%s (room full)', name)
    return ws.close();
  }

  // relay messages
  ws.on('message',function(message){
    var json = JSON.parse(message) || {}
    console.log('relaying %s message %s -> %s (%d bytes)',
      'candidate' in json ? 'candidate' : json.type || message,
      room.a === ws ? 'a' : 'b',
      room.a === ws ? 'b' : 'a',
      message.length
    )
    if( room.a === ws && room.b ) room.b.send(message);
    if( room.b === ws && room.a ) room.a.send(message);
  })

  ws.on('close',function(){
    console.log('closing %s@%s', room.a === ws ? 'a' : 'b', name)
    if( room.a === ws ){
      room.a = null;
      if( room.b ){
        console.log('sending close to b@%s',name)
        room.b.send(JSON.stringify({type:'close'}));
      }
    }
    if( room.b === ws ){
      room.b = null;
      if( room.a ){
        console.log('sending close to a@%s',name)
        room.a.send(JSON.stringify({type:'close'}));
      }
    }
    if( !room.a && !room.b ){
      delete rooms[name];
    }
  })
  room.a && room.a.send(JSON.stringify({a:!!room.a,b:!!room.b}));
  room.b && room.b.send(JSON.stringify({a:!!room.a,b:!!room.b}));
})


console.log('listening on port 8090')