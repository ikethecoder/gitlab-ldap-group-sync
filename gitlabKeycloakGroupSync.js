var co = require('co');
var every = require('schedule').every;
var Keycloak = require('./keycloak');
var NodeGitlab = require('node-gitlab');

module.exports = GitlabKeycloakGroupSync;

var isRunning = false;
var gitlab = undefined;
var keycloak = undefined;
var maintainerGroup = undefined;

function GitlabKeycloakGroupSync(config) {
  if (!(this instanceof GitlabKeycloakGroupSync))
    return new GitlabKeycloakGroupSync(config)

  gitlab = NodeGitlab.createThunk(config.gitlab);
  keycloak = new Keycloak(config.keycloak);

  maintainerGroup = config.maintainerGroup;
}


GitlabKeycloakGroupSync.prototype.sync = function () {

  if (isRunning) {
    console.log('ignore trigger, a sync is already running');
    return;
  }
  isRunning = true;

  co(function* () {

    // find all users with an external identiy
    var gitlabUsers = [];
    var pagedUsers = [];
    var i=0;
    do {
      i++;
      pagedUsers = yield gitlab.users.list({ per_page: 100, page: i });
      gitlabUsers.push.apply(gitlabUsers, pagedUsers);

    }
    while(pagedUsers.length == 100);

    //set the gitlab group members based on keycloak group
    var gitlabGroups = [];
    var pagedGroups = [];
    var i=0;
    do {
      i++;
      pagedGroups = yield gitlab.groups.list({ per_page: 100, page: i });
      gitlabGroups.push.apply(gitlabGroups, pagedGroups);

    }
    while(pagedGroups.length == 100);
    

    // Get all the Keycloak users
    var keycloakUserInventory = {}
    var keycloakUsers = yield keycloak.getUsers();
    console.log("Keycloak Users (" + keyloakUsers.length + "):");
    for (user of keycloakUsers) {
        console.log("    " + user.username + " enabled = " + user.enabled);
        keycloakUserInventory[user.username] = user;
    }
    console.log("--");

    var gitlabGroupNames = [maintainerGroup];

    for (var group of gitlabGroups) {
      gitlabGroupNames.push(group.name);
    }

    var gitlabUserMap = {};
    var gitlabLocalUserIds = [];
    for (var user of gitlabUsers) {
      if (user.identities.length > 0 && user.username in keycloakUserInventory) {
        // gitlabUserMap[user.identities[0].extern_uid] = user.id
        if (user.username.toLowerCase() != user.id) {
            console.log("gitlabUserMap: ", user.username.toLowerCase(), " != ", user.id);
        }
        gitlabUserMap[user.username.toLowerCase()] = user.id;
      } else {
        gitlabLocalUserIds.push(user.id);
      }
    }

    //get all keycloak groups and create a map with gitlab userid;
    var keycloakGroups = yield getAllKeycloakGroups(keycloak);
    console.log("Group Count ", keycloakGroups.length);

    var groupMembers = {};
    groupMembers[maintainerGroup] = [];

    for (var keycloakGroup of keycloakGroups) {
      if (gitlabGroupNames.indexOf(keycloakGroup.name) != -1) {
        console.log("Found group", keycloakGroup.name, "in gitlab.  Retrieving group members");
        groupMembers[keycloakGroup.name] = yield resolveKeycloakGroupMembers(keycloak, keycloakGroup, gitlabUserMap);
      }
    }

    for (var gitlabGroup of gitlabGroups) {
      console.log('-------------------------');
      console.log('group:', gitlabGroup.name);
      var gitlabGroupMembers = [];
      var pagedGroupMembers = [];
      var i=0;
      do {
        i++;
        pagedGroupMembers = yield gitlab.groupMembers.list({ id: gitlabGroup.id, per_page: 100, page: i });
        gitlabGroupMembers.push.apply(gitlabGroupMembers, pagedGroupMembers);

      }
      while(pagedGroupMembers.length == 100);

      var currentMemberIds = [];
      for (var member of gitlabGroupMembers) {
        if (gitlabLocalUserIds.indexOf(member.id) > -1) {
          continue; //ignore local users
        }
        if (member.access_level == 50) {
          continue; // ignore owners
        }

        var access_level = groupMembers[maintainerGroup].indexOf(member.id) > -1 ? 40 : 30;
        if (member.access_level !== access_level) {
          console.log('update group member permission', { id: gitlabGroup.id, user_id: member.id, access_level: access_level }, " upgrade from ", member.access_level);
          gitlab.groupMembers.update({ id: gitlabGroup.id, user_id: member.id, access_level: access_level });
        }

        currentMemberIds.push(member.id);
      }

      var members = groupMembers[gitlabGroup.name] || groupMembers[gitlabGroup.path] || groupMembers['default'] || [];

      //remove unlisted users
      var toDeleteIds = currentMemberIds.filter(x => members.indexOf(x) == -1);
      for (var id of toDeleteIds) {
        console.log('delete group member', { id: gitlabGroup.id, user_id: id });
        gitlab.groupMembers.remove({ id: gitlabGroup.id, user_id: id });
      }

      //add new users
      var toAddIds = members.filter(x => currentMemberIds.indexOf(x) == -1);
      for (var id of toAddIds) {
        var access_level = groupMembers[maintainerGroup].indexOf(id) > -1 ? 40 : 30;
        console.log('add group member', { id: gitlabGroup.id, user_id: id, access_level: access_level });
        gitlab.groupMembers.create({ id: gitlabGroup.id, user_id: id, access_level: access_level });
      }
    }

  }).then(function (value) {
    console.log('sync done');
    isRunning = false;
  }, function (err) {
    console.error(err.stack);
    isRunning = false;
  });
}

var ins = undefined;

GitlabKeycloakGroupSync.prototype.startScheduler = function (interval) {
  this.stopScheduler();
  ins = every(interval).do(this.sync);
}

GitlabKeycloakGroupSync.prototype.stopScheduler = function () {
  if (ins) {
    ins.stop();
  }
  ins = undefined;
}

function getAllKeycloakGroups(keycloak) {
  return keycloak.findGroups();

  // return new Promise(function (resolve, reject) {
  //   keycloak.findGroups(function (err, groups) {
  //     if (err) {
  //       reject(err);
  //       return;
  //     }
  //     console.log('groups read from keycloak:', groups.length);

  //     resolve(groups);
  //   });
  // });
}

function resolveKeycloakGroupMembers(keycloak, group, gitlabUserMap) {
  return new Promise(function (resolve, reject) {
    keycloak.getUsersForGroup(group.id).then (function (members) {
        groupMembers = [];
        for (var user of members) {
          if (gitlabUserMap[user.username.toLowerCase()]) {
              groupMembers.push(gitlabUserMap[user.username.toLowerCase()]);
          }
        }
        resolve(groupMembers);
    }).catch ((err) => {
        reject(err);
    });
  });

  // return new Promise(function (resolve, reject) {

  //   keycloak.getUsersForGroup(group.id, function (err, users) {
  //     if (err) {
  //       reject(err);
  //       return;
  //     }

  //     groupMembers = [];
  //     for (var user of users) {
  //       if (gitlabUserMap[user.uid.toLowerCase()]) {
  //           groupMembers.push(gitlabUserMap[user.uid.toLowerCase()]);
  //       }
  //     }
  //     resolve(groupMembers);
  //   });
  // });
}
