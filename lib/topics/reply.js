/*globals Gambit */
var Utils = require("../utils");
var Sort = require("./sort");
var async = require("async");

module.exports = function (mongoose) {

  var replySchema = new mongoose.Schema({
    id: {type: String, index: true, default: Utils.genId()},
    reply: {type: String, required: "{reply} is required.", trim: true},
    keep: {type: Boolean, default: false },
    filter: {type: String, default: ""},

    // Replies could referece other gambits
    // This forms the basis for the 'previous'
    gambits: [{ type: String, ref: "Gambit" }]
  });

  replySchema.methods.sortGambits = function (callback) {
    var self = this;
    var expandReorder = function (gambitId, cb) {
      Gambit.findById(gambitId, function (err, gambit) {
        cb(err, gambit);
      });
    };

    async.map(this.gambits, expandReorder, function (err, newGambitList) {
      if (err) {
        console.log(err);
      }

      var newList = Sort.sortTriggerSet(newGambitList);
      self.gambits = newList.map(function (g) {
        return g._id;
      });
      self.save(callback);
    });
  };
  try {
    return mongoose.model("Reply", replySchema);
  } catch(e) {
    return mongoose.model("Reply");
  }
};
