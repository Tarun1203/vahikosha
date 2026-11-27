"use strict";

/* The relay: the only place this app reaches the cloud (today Firebase:
   Firestore and Auth). Every other file asks the relay for a collection, a
   record or the sign-in, by name, so the workspace paths
   (workspaces/{wid}/...) and a later move to another service change this one
   file. See docs/design-multi-customer-sync.md, work package 1. This version
   does exactly what the app did before. Same file in the new app:
   react-app/src/lib/relay.ts. */

var Relay = (function(){
  var fs = null;
  return {
    // connects once; keeps working offline (queued saves upload when the connection returns)
    init: function(config){
      if(!firebase.apps.length) firebase.initializeApp(config);
      fs = firebase.firestore();
      fs.enablePersistence({synchronizeTabs: true}).catch(function(){});
      return fs;
    },
    // a collection, and one record in it (the one place the workspace prefix will be added)
    coll: function(name){ return fs.collection(name); },
    ref: function(name, id){ return fs.collection(name).doc(id); },
    // several writes saved together or not at all
    batch: function(){ return fs.batch(); },
    // "the time on the server when this reached it"
    now: function(){ return firebase.firestore.FieldValue.serverTimestamp(); },
    // signing in and out
    auth: function(){ return firebase.auth(); }
  };
})();
