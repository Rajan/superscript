var util = require("util");
var events = require("events");
var EventEmitter = events.EventEmitter;
var async = require("async");
var qtypes = require("qtypes");
var _ = require("underscore");
var norm = require("node-normalizer");
var requireDir = require("require-dir");
var debug = require("debug")("Script");
var facts = require("sfacts");
var gTopicsSystem = require("./lib/topics/index");
var Message = require("./lib/message");
var Users = require("./lib/users");
var getreply = require("./lib/getreply");
var Utils = require("./lib/utils");
// var Topics = require("./lib/topics");
// var processTags = require("./lib/processtags");

var mergex = require("deepmerge");

function SuperScript(options, callback) {
  EventEmitter.call(this);
  var mongoose;
  var self = this;
  options = options || {};

  // Create a new connection if non is provided.
  if (options.mongoose) {
    mongoose = options.mongoose;
  } else {
    mongoose = require("mongoose");
    mongoose.connect("mongodb://localhost/superscriptDB");
  }

  this._plugins = [];
  this.normalize = null;
  this.question = null;

  Utils.mkdirSync("./plugins");
  this.loadPlugins("./plugins");
  this.loadPlugins(process.cwd() + "/plugins");
  // this.intervalId = setInterval(this.check.bind(this), 500);

  this.factSystem = options.factSystem ? options.factSystem : facts.create("systemDB");
  this.topicSystem = gTopicsSystem(mongoose, this.factSystem);

  // This is a kill switch for filterBySeen which is useless in the editor.
  this.editMode = options.editMode || false;

  // We want a place to store bot related data
  this.memory = options.botfacts ? options.botfacts : this.factSystem.createUserDB("botfacts");

  this.scope = {};
  this.scope = _.extend(options.scope || {});
  this.scope.facts = this.factSystem;
  this.scope.topicSystem = this.topicSystem;
  this.scope.botfacts = this.memory;

  this.users = new Users(mongoose, this.factSystem);

  norm.loadData(function () {
    self.normalize = norm;
    new qtypes(function (question) {
      self.question = question;
      debug("System Loaded, waiting for replies");
      callback(null, self);
    });
  });
}

var messageItorHandle = function (user, system) {
  var messageItor = function (msg, next) {

    var options = {
      user: user,
      system: system,
      message: msg
    };

    getreply(options, function (err, replyObj) {
      // Convert the reply into a message object too.

      var msgString = "";
      var messageOptions = {
        qtypes: system.question,
        norm: system.normalize,
        facts: system.facts
      };

      if (replyObj) {
        messageOptions.replyId = replyObj.id;
        msgString = replyObj.string;
      } else {
        replyObj = {};
      }

      new Message(msgString, messageOptions, function (replyMessageObject) {
        user.updateHistory(msg, replyMessageObject);

        // We send back a smaller message object to the clients.
        var clientObject = {
          replyId: replyObj.replyId,
          createdAt: replyMessageObject.createdAt || new Date(),
          string: replyMessageObject.raw || "",
          gambitId: replyObj.gambitId,
          topicName: replyObj.topicName
        };

        var newClientObject = mergex(clientObject, replyObj.props || {});

        user.save(function () {
          return next(err, newClientObject);
        });
      });
    });
  };
  return messageItor;
};

// This takes a message and breaks it into chucks to be passed though
// the sytem. We put them back together on the other end.
var messageFactory = function (rawMsg, question, normalize, facts, cb) {

  var messageParts = Utils.sentenceSplit(normalize.clean(rawMsg).trim());
  messageParts = Utils.cleanArray(messageParts);

  var itor = function (messageChunk, next) {

    var messageOptions = {
      qtypes: question,
      norm: normalize,
      facts: facts
    };

    new Message(messageChunk.trim(), messageOptions, function (tmsg) {
      next(null, tmsg);
    });
  };

  return async.mapSeries(messageParts, itor, function (err, messageArray) {
    return cb(messageArray);
  });
};

util.inherits(SuperScript, EventEmitter);

SuperScript.prototype.message = function (msgString, callback) {

  var messageOptions = {
    qtypes: this.question,
    norm: this.normalize,
    facts: this.factSystem
  };

  var message = new Message(msgString, messageOptions, function (msgObj) {
    callback(null, msgObj);
  });
};


// Convert msg into message object, then check for a match
SuperScript.prototype.reply = function (userId, msg, callback) {
  if (arguments.length === 2 && typeof msg === "function") {
    callback = msg;
    msg = userId;
    userId = Math.random().toString(36).substr(2, 5);
  }

  debug("Message Recieved from '" + userId + "'", msg);
  var self = this;

  // Ideally these will come from a cache, but self is a exercise for a rainy day
  var system = {

    // getReply
    topicsSystem: self.topicSystem,
    plugins: self._plugins,
    scope: self.scope,

    // Message
    question: self.question,
    normalize: self.normalize,
    facts: self.factSystem,
    editMode: self.editMode
  };

  var properties = { id: userId };
  var prop = {
    currentTopic: "random",
    status: 0,
    conversation: 0, volley: 0, rally: 0
  };

  this.users.findOrCreate(properties, prop, function (err1, user) {
    if (err1) {
      console.log(err1);
    }
    messageFactory(msg, self.question, self.normalize, self.factSystem, function (messages) {
      async.mapSeries(messages, messageItorHandle(user, system), function (err2, messageArray) {
        if (err2) {
          console.log(err2);
        }

        var reply = {};
        messageArray = Utils.cleanArray(messageArray);

        if (_.isEmpty(messageArray)) {
          reply.string = "";
        } else if (messageArray.length === 1) {
          reply = messageArray[0];
        } else {

          // TODO - We will want to add some smarts on putting multiple
          // lines back together - check for tail grammar or drop bits.
          reply = messageArray[0];
          var messageReplies = [];
          reply.parts = [];
          for (var i = 0; i < messageArray.length; i++) {
            reply.parts[i] = {
              string: messageArray[i].string,
              triggerId: messageArray[i].triggerId,
              topicName: messageArray[i].topicName
            };

            if (messageArray[i].string !== "") {
              messageReplies.push(messageArray[i].string);
            }

            for (var nprop in messageArray[i]) {
              if (nprop !== "createdAt" && nprop !== "string") {
                reply[nprop] = messageArray[i][nprop];
              }
            }
          }

          reply.string = messageReplies.join(" ");
        }

        debug("Update and Reply to user '" + user.id + "'", reply);
        return callback(err2, reply);
      });
    });
  });
};

SuperScript.prototype.loadPlugins = function (path) {
  var plugins = requireDir(path);

  for (var file in plugins) {
    for (var func in plugins[file]) {
      debug("Loading Plugin", path, func);
      this._plugins[func] = plugins[file][func];
    }
  }
};

SuperScript.prototype.getPlugins = function () {
  return this._plugins;
};

SuperScript.prototype.getTopics = function () {
  return this.topics;
};

SuperScript.prototype.getUsers = function (cb) {
  this.users.find({}, "id", cb);
};

SuperScript.prototype.getUser = function (userId, cb) {
  debug("Fetching User", userId);

  this.users.findOne({id: userId}, function (err, usr) {
    cb(err, usr);
  });
};

SuperScript.prototype.findOrCreateUser = function (userId, callback) {
  var properties = { id: userId };
  var prop = {
    currentTopic: "random",
    status: 0,
    conversation: 0, volley: 0, rally: 0
  };

  this.users.findOrCreate(properties, prop, callback);
};


// SuperScript.prototype.userConnect = function(userId, callback) {
//   debug("Connecting User", userId);
//   return Users.connect(userId, this.facts, callback);
// }

// TODO: Revisit this.
// SuperScript.prototype.userDisconnect = function(userId) {
//   debug("userDisconnect User", userId);
//   return Users.disconnect(userId);
// }

// var firstReplyTime = Utils.getRandomInt(3000, 10000);
// var secondReplyTime = firstReplyTime + Utils.getRandomInt(3000, 10000);

// This is really the difference between a personal assistant and
// a full blown conversation engine.
//
// This function is fired every 500ms
// We check to see who is connected to the bot, and what conversations
// are currently happening.
// We use this method to fire off messages to users who have:
// - Not yet engagued with the bot. (delayed first reply)
// - Idle for a length of time (6s ~ 20s)
// - Convesation has run dry.
//
// This method emits a "message" event on bot and sends back a userID
// so you will need to pair the user back to a socket.
//
// SuperScript.prototype.check = function() {
//   var self = this;
//   var users = Users.getOnline();
//   var currentTimestamp = (new Date()).getTime();

//   var sendMessage = function(message, user, cb) {

//     var gScope = self.scope;
//     gScope.user = user;

//     var options = {
//       plugins: self._plugins,
//       scope: gScope
//     };

//     // TODO - Reply Object has changed, and we need to mimic self here.
//     var reply = {};

//     processTags(reply, user, options, function afterProcessTags(err, reply){
//       var messageOptions = {
//         qtypes: self.question,
//         norm: self.normalize,
//         facts: self.facts
//       };
//       new Message(reply, messageOptions, function(replyObj) {

//         debug("User Saved");
//         user.updateHistory(null, replyObj);
//         self.emit('message', user.name, reply);
//         cb();

//       });
//     });
//   }

//   var itor = function(user, next) {

//     // Are we in a topic?
//     var currentTopic = user.getTopic();

//     var thingsToSay = [];
//     var firstToSay = [];

//     for (message in self._topics[currentTopic]) {
//       if(self._topics[currentTopic][message].say !== undefined) {
//         if(self._topics[currentTopic][message].options.index !== undefined) {
//           firstToSay.push(self._topics[currentTopic][message].say);
//         } else {
//           thingsToSay.push(self._topics[currentTopic][message].say);
//         }
//       }
//     }

//     var durationMs = currentTimestamp - user.conversationStartedAt;

//     if (user.lastMessageSentAt === null && !_.isEmpty(firstToSay)) {
//       var reply = Utils.pickItem(firstToSay);
//       // Only say the firstReply message once
//       if (durationMs > firstReplyTime && durationMs < firstReplyTime + 500) {
//         sendMessage(reply, user, next);
//       } else if(durationMs > secondReplyTime && durationMs < secondReplyTime + 500) {
//         sendMessage(reply, user, next);
//       } else {
//         next();
//       }

//     } else if(!_.isEmpty(thingsToSay)) {
//       var reply = Utils.pickItem(thingsToSay);

//       // We have said something, but now the conversation is dried up.
//       // Either rally 0, or time ellapsed since last message
//       var durationMs = currentTimestamp - user.lastMessageSentAt;

//       // Some random time between 6s, and 20s
//       var ellapsedTime = firstReplyTime * 2;

//       if(durationMs > ellapsedTime && durationMs < ellapsedTime + 500) {
//         sendMessage(reply, user, next);
//       } else {
//         next();
//       }
//     } else {
//       next();
//     }
//   }

//   async.each(users, itor, function() {});
// }

module.exports = SuperScript;
