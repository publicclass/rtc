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
  User string
  Token string
}

func Main(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  w.Header().Set("Content-Type", "text/html; charset=utf-8")

  roomName := strings.TrimLeft(r.URL.Path,"/")
  userName := Random(10)

  // Data to be sent to the template:
  data := Template{Room: roomName, User: userName}

  // Empty room
  if _, err := GetRoom(c, roomName); err != nil {
    room := new(Room)
    c.Debugf("Created room %s",roomName)
    if err := PutRoom(c, roomName, room); err != nil {
      c.Criticalf("!!! could not save room: %s", err)
      return;
    }

  // DataStore error
  } else if err != nil {
    c.Criticalf("Error occured while getting room %s",roomName,err)
    return;
  }

  // Create a channel token
  clientId := MakeClientId(roomName, userName)
  token, err := channel.Create(c, clientId)
  if err != nil {
    c.Criticalf("Error while creating token: %s", err)
  }
  data.Token = token

  // Parse the template and output HTML:
  template, err := template.ParseFiles("example-appchan.html")
  if err != nil { c.Criticalf("execution failed: %s", err) }
  err = template.Execute(w, data)
  if err != nil { c.Criticalf("execution failed: %s", err) }
}

func OnConnect(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  roomName, userName := ParseClientId(r.FormValue("from"))

  c.Debugf("Connected user %s to room %s",userName,roomName)

  if room, err := GetRoom(c, roomName); err == nil {

    // see if user is in room
    if room.HasUser(userName) {
      // user already in the room
      // just send "connected" again in
      // case it was missed last time
      c.Debugf("User already in room")

    // or see if it's full
    } else if room.Occupants() == 2 {
      c.Debugf("Room full")
      if err := channel.Send(c, MakeClientId(roomName, userName), "full"); err != nil {
        c.Criticalf("Error while sending full:",err)
      }
      return;

    // or add a user to the room
    } else {
      c.Debugf("Adding user to room")
      room.AddUser(userName)
      if err := PutRoom(c, roomName, room); err != nil {
        c.Criticalf("Connected could not put room %s: ",roomName,err)
      }
    }

    // send connected to both when room is complete
    if room.Occupants() == 2 {
      otherUser := room.OtherUser(userName)
      c.Debugf("Room Complete, sending 'connected' to %s and %s",userName,otherUser)
      if err := channel.Send(c, MakeClientId(roomName, otherUser), "connected"); err != nil {
        c.Criticalf("Error while sending connected:",err)
      }
      if err := channel.Send(c, MakeClientId(roomName, userName), "connected"); err != nil {
        c.Criticalf("Error while sending connected:",err)
      }
    } else {
      c.Debugf("Waiting for another user before sending 'connected'")
    }

  } else {
    c.Criticalf("Could not get room %s: ",roomName,err)
  }
}

func OnDisconnect(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)
  roomName, userName := ParseClientId(r.FormValue("from"))
  if room, err := GetRoom(c, roomName); err == nil {

    if room.HasUser(userName) == false {
      c.Debugf("User %s not found in room %s",userName,roomName)
      return;
    }

    // get the other user before we remove the current one
    otherUser := room.OtherUser(userName)
    empty := room.RemoveUser(userName)
    c.Debugf("Removed user %s from room %s",userName,roomName)

    // delete empty rooms
    if empty {
      err := DelRoom(c, roomName)
      if err != nil {
        c.Criticalf("Could not del room %s: ",roomName,err)
      } else {
        c.Debugf("Removed empty room %s",roomName)
      }

    // save room if not empty
    } else {
      err := PutRoom(c, roomName, room)
      if err != nil {
        c.Criticalf("... Could not put room %s: ",roomName,err)
      } else if otherUser != "" {
        c.Debugf("disconnected sent to %s",MakeClientId(roomName, otherUser))
        if err := channel.Send(c, MakeClientId(roomName, otherUser), "disconnected"); err != nil {
          c.Criticalf("Error while sending disconnected:",err)
        }
        c.Debugf("disconnected sent to %s",MakeClientId(roomName, userName))
        if err := channel.Send(c, MakeClientId(roomName, userName), "disconnected"); err != nil {
          c.Criticalf("Error while sending disconnected:",err)
        }
      } else {
        c.Criticalf("We should never get here because the room should be empty.")
      }
    }
  } else {
    c.Criticalf("Could not get room %s: ",roomName,err)
  }
}

func OnMessage(w http.ResponseWriter, r *http.Request) {
  c := appengine.NewContext(r)

  roomName, userName := ParseClientId(r.FormValue("from"))

  b, err := ioutil.ReadAll(r.Body);
  if err != nil {
    c.Criticalf("%s",err)
    return
  }
  r.Body.Close()

  c.Debugf("received channel data message: %s",b)

  room, err := GetRoom(c, roomName)
  if err != nil {
    c.Criticalf("Error while retreiving room:",err)
  }
  otherUser := room.OtherUser(userName)
  if otherUser != "" {
    if err := channel.Send(c, MakeClientId(roomName, otherUser), string(b)); err != nil {
      c.Criticalf("Error while sending JSON:",err)
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
  str = re.ReplaceAllLiteralString(str,".")
  return str
}

func init() {
  now := time.Now()
  rand.Seed(now.Unix())
  http.HandleFunc("/", Main)
  http.HandleFunc("/message", OnMessage)
  http.HandleFunc("/connect", OnConnect)
  http.HandleFunc("/disconnect", OnDisconnect)
  http.HandleFunc("/_ah/channel/connected/", OnConnect)
  http.HandleFunc("/_ah/channel/disconnected/", OnDisconnect)
}

