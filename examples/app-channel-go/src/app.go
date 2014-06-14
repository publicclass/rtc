package rtc

import (
  "appengine"
  "appengine/channel"
  "encoding/json"
  "math/rand"
  "net/http"
  "text/template"
  "regexp"
  "strings"
  "io/ioutil"
  "time"
)

type Template struct {
  Room string
}

func Main(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  w.Header().Set("Content-Type", "text/html; charset=utf-8")

  // clean up the roomName to avoid xss
  roomName := Cleanup(strings.TrimLeft(r.URL.Path,"/"))

  // Data to be sent to the template:
  data := Template{Room: roomName}

  if roomName == "" {
    c.Debugf("Room with no name. Redirecting.")
    roomName = Random(6)
    http.Redirect(w, r, roomName, 302);

  } else {
    room, err := GetRoom(c, roomName)

    // Empty room
    if room == nil {
      room = new(Room)
      c.Debugf("Created room %s",roomName)
      if err := PutRoom(c, roomName, room); err != nil {
        c.Criticalf("Error occured while creating room %s: %+v", roomName, err)
        return;
      }

    // DataStore error
    } else if err != nil {
      c.Criticalf("Error occured while getting room %s: %+v",roomName,err)
      return;
    }
  }

  // Parse the template and output HTML:
  template, err := template.ParseFiles("template.html")
  if err != nil { c.Criticalf("execution failed: %s", err) }
  err = template.Execute(w, data)
  if err != nil { c.Criticalf("execution failed: %s", err) }
}

func OnToken(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  roomName := r.FormValue("room")
  if roomName != "" {
    userName := Random(10)
    clientId := MakeClientId(roomName, userName)
    token, err := channel.Create(c, clientId)
    if err != nil {
      c.Criticalf("Error while creating token: %s", err)
    }
    w.Write([]byte("user="+userName+"&token="+token))
  } else {
    w.WriteHeader(http.StatusBadRequest)
  }
}

func OnConnect(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  roomName, userName := ParseClientId(r.FormValue("from"))

  c.Debugf("Connected user %s to room %s",userName,roomName)

  if room, err := GetRoom(c, roomName); err == nil {

    // see if user is in room
    if room.HasUser(userName) {
      c.Debugf("User already in room")
      // user already in the room
      // just send "connected" again in
      // case it was missed last time

    // or see if it's full
    } else if room.Occupants() == 2 {
      c.Debugf("Room Full, sending 'full' to %s",userName)
      if err := channel.Send(c, MakeClientId(roomName, userName), "full"); err != nil {
        c.Criticalf("OnConnect: Error while sending full:",err)
      }
      return;

    // or add a user to the room
    } else {
      room.AddUser(userName)
      err = PutRoom(c, roomName, room)
      if err != nil {
        c.Criticalf("OnConnect: Connected could not put room %s: ",roomName,err)
        return
      }
    }

    // send connected to both when room is complete
    if room.Occupants() == 2 {
      otherUser := room.OtherUser(userName)
      c.Debugf("Room Complete, sending 'connected' to %s and %s",userName,otherUser)
      if err := channel.Send(c, MakeClientId(roomName, otherUser), "connected"); err != nil {
        c.Criticalf("OnConnect: Error while sending connected:",err)
      }
      if err := channel.Send(c, MakeClientId(roomName, userName), "connected"); err != nil {
        c.Criticalf("OnConnect: Error while sending connected:",err)
      }
    } else {
      c.Debugf("Waiting for another user before sending 'connected'")
    }

  } else {
    c.Criticalf("OnConnect: Could not get room %s: ",roomName,err)
  }
}

func OnDisconnect(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  roomName, userName := ParseClientId(r.FormValue("from"))
  if room, err := GetRoom(c, roomName); err == nil {

    if room.HasUser(userName) == false {
      c.Debugf("OnDisconnect: User %s not found in room %s",userName,roomName)
      return;
    }

    // get the other user before we remove the current one
    otherUser := room.OtherUser(userName)
    empty := room.RemoveUser(userName)
    c.Debugf("OnDisconnect: Removed user %s from room %s",userName,roomName)

    err := PutRoom(c, roomName, room)
    if err != nil {
      c.Criticalf("OnDisconnect: Could not put room %s: ",roomName,err)
      return;
    }

    if empty {
      c.Debugf("OnDisconnect: Room is now empty.")

    } else if otherUser != "" {
      c.Debugf("Removed %s. Sending 'disconnected' to %s",userName,MakeClientId(roomName, otherUser))
      if err := channel.Send(c, MakeClientId(roomName, otherUser), "disconnected"); err != nil {
        c.Criticalf("OnDisconnect: Error while sending 'disconnected':",err)
      }
      c.Debugf("Removed %s. Sending 'disconnected' to %s",userName,MakeClientId(roomName, userName))
      if err := channel.Send(c, MakeClientId(roomName, userName), "disconnected"); err != nil {
        c.Criticalf("OnDisconnect: Error while sending 'disconnected':",err)
      }
    }
  } else {
    c.Criticalf("OnDisconnect: Could not get room %s: ",roomName,err)
  }
}

func OnMessage(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)

  roomName, userName := ParseClientId(r.FormValue("from"))

  b, err := ioutil.ReadAll(r.Body);
  if err != nil {
    c.Criticalf("OnMessage: Error while reading body: %s",err)
    return
  }
  r.Body.Close()

  room, err := GetRoom(c, roomName)
  if err != nil {
    c.Criticalf("OnMessage: Error while retreiving room %s:",roomName,err)
    return
  }

  c.Debugf("received channel data message from %s in %s: %s",userName,roomName,b)

  otherUser := room.OtherUser(userName)
  if otherUser != "" {
    if err := channel.Send(c, MakeClientId(roomName, otherUser), string(b)); err != nil {
      c.Criticalf("OnMessage: Error while sending JSON:",err)
      return
    }
  }

  w.Write([]byte("OK"))
}

func MakeClientId(room string, user string) string {
  return user + "-" + room;
}

func ParseClientId(clientId string) (string, string) {
  from := strings.Split(clientId, "-")
  // room, user
  return from[1], from[0]
}

func Random(length int) string {
  printables := "abcdefghijklmnopqrstuvwxyx"
  result := ""
  for i := 0; i < length; i++ {
    pos := rand.Intn(len(printables) - 1)
    result = result + printables[pos:pos + 1]
  }
  return result
}

func ReadData(d []byte) (interface{}, error) {
  var data interface{}
  if err := json.Unmarshal(d, &data); err != nil {
    return data, err
  }
  return data, nil
}

func Cleanup(str string) string {
  re := regexp.MustCompile("[^\\w\\d]+")
  str = re.ReplaceAllLiteralString(str,"-")
  re = regexp.MustCompile("-+")
  str = re.ReplaceAllLiteralString(str,"-")
  return strings.Trim(str,"- ")
}

func init() {
  now := time.Now()
  rand.Seed(now.Unix())
  http.HandleFunc("/", Main)
  http.HandleFunc("/_token", OnToken)
  http.HandleFunc("/_message", OnMessage)
  http.HandleFunc("/_connect", OnConnect)
  http.HandleFunc("/_disconnect", OnDisconnect)
  http.HandleFunc("/_ah/channel/connected/", OnConnect)
  http.HandleFunc("/_ah/channel/disconnected/", OnDisconnect)
}

