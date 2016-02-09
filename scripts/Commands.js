/**
 * scripts/Commands.js
 * 
 * This file provides the main game logic; unfortunately it's 
 * not complete so you'll need to finish it!
 *
 * @author Jonathon Hare (jsh2@ecs.soton.ac.uk)
 * @author ...
 */
var db = require('../models');
var controller = require('./Controller');
var predicates = require('./Predicates');
var strings = require('./Strings');
var CommandHandler = require('./CommandHandler');
var PropertyHandler = require('./PropertyHandler');
var bfs = require('async-bfs');

/**
 * The commands object is like a map of control strings (the commands detailed 
 * in the ECS-MUD guide) to command handlers (objects extending from the 
 * CommandHandler object) which perform the actions of the required command.
 * 
 * The controller (see Controller.js) parses the statements entered by the user,
 * and passes the information to the matching property in the commands object.
 */
var commands = {
	//handle user creation
	create: CommandHandler.extend({
		nargs: 2,
		preLogin: true,
		postLogin: false,
		validate: function(conn, argsArr, cb) {
			if (!predicates.isUsernameValid(argsArr[0])) {
				controller.sendMessage(conn, strings.badUsername);
				return;
			}

			if (!predicates.isPasswordValid(argsArr[1])) {
				controller.sendMessage(conn, strings.badPassword);
				return;
			}

			controller.loadMUDObject(conn, {name: argsArr[0], type: 'PLAYER'}, function(player) {
				if (!player) {
					cb(conn, argsArr);
				} else {
					controller.sendMessage(conn, strings.usernameInUse);
				}
			});
		},
		perform: function(conn, argsArr) {
			//create a new player
			controller.createMUDObject(conn,
				{
					name: argsArr[0],
					password: argsArr[1],
					type:'PLAYER',
					locationId: controller.defaultRoom.id,
					targetId: controller.defaultRoom.id
				}, function(player) {
				if (player) {
					player.setOwner(player).success(function() {
						controller.activatePlayer(conn, player);
						controller.broadcastExcept(conn, strings.hasConnected, player);

						controller.clearScreen(conn);
						commands.look.perform(conn, []);
					});
				}
			});
		}
	}),
	//handle connection of an existing user
	connect: CommandHandler.extend({
		nargs: 2,
		preLogin: true,
		postLogin: false,
		validate: function(conn, argsArr, cb) {
			controller.loadMUDObject(conn, {name: argsArr[0], type:'PLAYER'}, function(player) {
				if (!player) {
					controller.sendMessage(conn, strings.playerNotFound);
					return;
				}

				if (player.password !== argsArr[1]) {
					controller.sendMessage(conn, strings.incorrectPassword);
					return;
				}

				cb(conn, argsArr);
			});
		},
		perform: function(conn, argsArr) {
			//load player if possible:
			controller.loadMUDObject(conn, {name: argsArr[0], password: argsArr[1], type:'PLAYER'}, function(player) {
				if (player) {
					controller.applyToActivePlayers(function(apconn, ap) {
						if (ap.name === argsArr[0]) {
							//player is already connected... kick them off then rejoin them
							controller.deactivatePlayer(apconn);
							return false;
						}
					});

					controller.activatePlayer(conn, player);
					controller.broadcastExcept(conn, strings.hasConnected, player);

					controller.clearScreen(conn);
					commands.look.perform(conn, []);
				}
			});
		}
	}),
	//Disconnect the player
	QUIT: CommandHandler.extend({
		preLogin: true,
		perform: function(conn, argsArr) {
			conn.terminate();
		}
	}),
	//List active players
	WHO: CommandHandler.extend({
		preLogin: true,
		perform: function(conn, argsArr) {
			controller.applyToActivePlayers(function(otherconn, other) {
				if (otherconn !== conn) {
					controller.sendMessage(conn, other.name);
				}
			});
		}
	}),
	//Speak to other players 
	say: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			cb(conn, argsArr);
		},
		perform: function(conn, argsArr) {
			var message = argsArr.length===0 ? "" : argsArr[0];
			var player = controller.findActivePlayerByConnection(conn);

			controller.sendMessage(conn, strings.youSay, {message: message});
			controller.sendMessageRoomExcept(conn, strings.says, {name: player.name, message: message});
		}
	}),
	//Move the player somewhere
	go: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb(conn, argsArr);
			} else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr, errMsg) {
			var player = controller.findActivePlayerByConnection(conn);
			var exitName = argsArr[0];

			if (exitName === 'home') {
				player.getTarget().success(function(loc) {
					controller.applyToActivePlayers(function(otherconn, other) {
						if (other.locationId === loc.id && player !== other) {
							controller.sendMessage(otherconn, strings.goesHome, {name: player.name});
						}
					});

					player.getContents().success(function(contents){
						if (contents) {
							var chainer = new db.Sequelize.Utils.QueryChainer();
							for (var i=0; i<contents.length; i++) {
								var ci = contents[i];
								ci.locationId = ci.targetId;
								chainer.add(ci.save());
							}
							chainer.run().success(function(){
								//don't need to do anything
							});
						}

						for (var i=0; i<3; i++)
							controller.sendMessage(conn, strings.noPlaceLikeHome);
						
						player.setLocation(loc).success(function() {
							controller.sendMessage(conn, strings.goneHome);
							commands.look.lookRoom(conn, loc);
						});
					});
				});
			} else {
				controller.findPotentialMUDObject(conn, exitName, function(exit) {
					//found a matching exit... can we use it?
					predicates.canDoIt(controller, player, exit, function(canDoIt) {
						if (canDoIt && exit.targetId) {
							exit.getTarget().success(function(loc) {
								if (loc.id !== player.locationId) {
									//only inform everyone else if its a different room
									controller.applyToActivePlayers(function(otherconn, other) {
										if (other.locationId === player.locationId && player !== other) {
											controller.sendMessage(otherconn, strings.leaves, {name: player.name});
										}
										if (other.locationId === loc.id && player !== other) {
											controller.sendMessage(otherconn, strings.enters, {name: player.name});
										}
									});
								
									player.setLocation(loc).success(function() {
										commands.look.lookRoom(conn, loc);
									});
								} else {
									commands.look.lookRoom(conn, loc);
								}
							});
						}
					}, strings.noGo);
				}, false, false, 'EXIT', strings.ambigGo, errMsg ? errMsg : strings.noGo);
			}
		}
	}),
	//Look at something
	look: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length <= 1)
				cb(conn, argsArr);
			else
				controller.sendMessage(conn, strings.unknownCommand);
		},
		perform: function(conn, argsArr) {
			var player = controller.findActivePlayerByConnection(conn);

			if (argsArr.length === 0 || argsArr[0].length===0) {
				player.getLocation().success(function(room) {
					commands.look.look(conn, room);
				});
			} else {
				controller.findPotentialMUDObject(conn, argsArr[0], function(obj) {
					commands.look.look(conn, obj);
				}, true, true, undefined, undefined, undefined, true);
			}
		},
		look: function(conn, obj) {
			switch (obj.type) {
				case 'ROOM':
					commands.look.lookRoom(conn, obj);
					break;
				case 'PLAYER':
					commands.look.lookSimple(conn, obj);
					commands.look.lookContents(conn, obj, strings.carrying);
					break;
				default:
					commands.look.lookSimple(conn, obj);
			}
		},
		lookRoom: function(conn, room) {
			var player = controller.findActivePlayerByConnection(conn);

			if (predicates.isLinkable(room, player)) {
				controller.sendMessage(conn, strings.roomNameOwner, room);
			} else {
				controller.sendMessage(conn, strings.roomName, room);
			}
			if (room.description) controller.sendMessage(conn, room.description);

			predicates.canDoIt(controller, player, room, function() {
				commands.look.lookContents(conn, room, strings.contents);
			});
		},
		lookSimple: function(conn, obj) {
			controller.sendMessage(conn, obj.description ? obj.description : strings.nothingSpecial);
		},
		lookContents: function(conn, obj, name, fail) {
			obj.getContents().success(function(contents) {
				if (contents) {
					var player = controller.findActivePlayerByConnection(conn);

					contents = contents.filter(function(o) {
						return predicates.canSee(player, o);
					});

					if (contents.length>0) {
						controller.sendMessage(conn, name);
						for (var i=0; i<contents.length; i++) {
							controller.sendMessage(conn, contents[i].name);
						}
					} else {
						if (fail)
							controller.sendMessage(conn, fail);
					}
				} 
			});
		}
	}),
	//set the description of something
	"@describe": PropertyHandler.extend({
		prop: 'description'
	}),
	//Whisper something to another player
	whisper: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb(conn, argsArr);
			} else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr) {
			var index = argsArr[0].indexOf("=");
			// if there is no "=" sign in the input, output strings.unknownCommand
			if (index !== -1) {
				var targetName = argsArr[0].substring(0, index).trim();
				var message = argsArr[0].substring(index + 1).trim();
				var me = controller.findActivePlayerByConnection(conn);
				var targetPlayer = controller.findActivePlayerByName(targetName);

				if (targetPlayer !== undefined ) {
						targetConn = controller.findActiveConnectionByPlayer(targetPlayer);
						if (targetPlayer.locationId === me.locationId) {
							controller.sendMessage(targetConn, strings.toWhisper, {name: me.name, message: message});
							controller.sendMessage(conn, strings.youWhisper, {message: message, name: targetPlayer.name});
							// for all active players apart from the target and me (who whispers), output strings.overheard or strings.whisper
							controller.applyToActivePlayers(function(otherconn, other){ 
								if (other.locationId === me.locationId && other.name !== targetName && other.name !== me.name) {
									if (Math.floor((Math.random() * 10) + 1) === 1) {
										controller.sendMessage(otherconn, strings.overheard, {fromName: me.name, message: message, toName: targetName});
									}
									else {
										controller.sendMessage(otherconn, strings.whisper, {fromName: me.name, toName: targetName});
									}
								}
							});
						}
						else {
							controller.sendMessage(conn, strings.notInRoom);
						}
				}
				else {
					controller.sendMessage(conn, strings.notConnected, {name: targetName});
				}
			}
			else {
				controller.sendMessage(conn, strings.unknownCommand);
			}

		}
	}),
	//Lists what objects you are carrying 
	inventory: CommandHandler.extend({
		postLogin: true,
		perform: function(conn) {
			var player = controller.findActivePlayerByConnection(conn);
			// for every object returned from getContents, apend its name to a string and print the string at the end
			player.getContents().success(function(objects){
				var carryingMessage = strings.youAreCarrying + " "; 
				if (objects.length > 0) {
					for (var i=0; i < objects.length; i++) {
						if (i === objects.length-1) {
							carryingMessage += objects[i].name + ".";
						}
						else {
							carryingMessage += objects[i].name + ", ";
						}
					}
					controller.sendMessage(conn, carryingMessage);
				}
				else {
					controller.sendMessage(conn, strings.carryingNothing);
				}
			});
		}
	}),
	//Creates a new room
	"@dig": PropertyHandler.extend({
		prop: 'name',
		perform: function(conn, argsArr) {
			var name = argsArr.length===0 ? "" : argsArr[0];
			var player;
			if (predicates.isNameValid(name)) {
				player = controller.findActivePlayerByConnection(conn);
				controller.createMUDObject(conn,
					{
						name: name,
						type:'ROOM'
					}, function(object) {
					if (object) {
						controller.sendMessage(conn, strings.roomCreated, {name: name, id: object.id});
					}
				});
			}
			else {
				controller.sendMessage(conn, strings.invalidName);
			}
		}
	}),
	//Set the successMessage of something
	"@success": PropertyHandler.extend({
		prop: 'successMessage'
	}),
	//Set the otherSuccessMessage of something
	"@osuccess": PropertyHandler.extend({
		prop: 'othersSuccessMessage'
	}),
	//Set the failureMessage of something
	"@failure": PropertyHandler.extend({
		prop: 'failureMessage'
	}),
	//Set the othersFailureMessage of something
	"@ofailure": PropertyHandler.extend({
		prop: 'othersFailureMessage'
	}),
	//Set the name of an object or the direction list for an exit (need to change to add predicate isNameValid)
	"@name": PropertyHandler.extend({
		prop: 'name',
		validate: function(conn, argsArr, cb) {
		if (argsArr.length === 1) {
			var index = argsArr[0].indexOf("=");
			index = (index === -1) ? argsArr[0].length : index;
			var targetName = argsArr[0].substring(0, index).trim();
			var value = argsArr[0].substring(index + 1).trim();
			// the split is being done here as well even though it is done in the perform
			// for the reason of checking whether the name is valid or not
			if (predicates.isNameValid(value)) {
				cb.apply(this, [conn, argsArr]);
			}
			else{
				controller.sendMessage(conn, strings.unknownCommand);	
			}
		}
		else{
			controller.sendMessage(conn, strings.unknownCommand);
		}
		},
	}),
	//Changes the users' password
	"@password": CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb.apply(this, [conn, argsArr]);
			}
			else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr) { 
			var index = argsArr[0].indexOf("=");
			index = (index === -1) ? argsArr[0].length : index;
			var oldPass = argsArr[0].substring(0, index).trim();
			var newPass = argsArr[0].substring(index + 1).trim();
			var me = controller.findActivePlayerByConnection(conn);
			// if the old password is correct and the new one is valid, change the password
			if (me.password === oldPass && predicates.isPasswordValid(newPass)) {
				me.password = newPass;
				me.save();
				controller.sendMessage(conn, strings.changePasswordSuccess);
			}
			else {
				controller.sendMessage(conn, strings.changePasswordFail);
			}
		}	
	}),
	//Opens a new exit
	"@open": PropertyHandler.extend({
		prop: 'name',
		perform: function(conn, argsArr) {
			var directionsString = argsArr.length===0 ? "" : argsArr[0];
			var directions = directionsString.split(";");
			var me;
			var directionsOK = true;
			// if at least one of the given directions is invalid, set a flag to not procede further 
			for (var i=0; i<directions.length; i++) {
				if (!predicates.isNameValid(directions[i])) {
					directionsOK = false;
					break;
				}
			}
			if (directionsOK) {
				me = controller.findActivePlayerByConnection(conn);
				me.getLocation().success(function(room) {
					if(room.ownerId === me.id) {		
						// create object with the current room location and set me as an owner
						controller.createMUDObject(conn,
							{
								name: directionsString,
								type:'EXIT',
								locationId: me.locationId,
								ownerId: me.id
							}, function(object) {
							if (object) {
								controller.sendMessage(conn, strings.opened);
							}
						});
					}
					else {
						controller.sendMessage(conn, strings.permissionDenied);
					}
				});
			}
			else {
				controller.sendMessage(conn, strings.invalidName);
			}
		}
	}),
	//Links various objects to rooms 
	"@link": CommandHandler.extend({
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb.apply(this, [conn, argsArr]);
			}
			else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr) {
			var index = argsArr[0].indexOf("=");
			index = (index === -1) ? argsArr[0].length : index;
			var targetName = argsArr[0].substring(0, index).trim();
			var roomNumber = argsArr[0].substring(index + 1).trim();

			var me = controller.findActivePlayerByConnection(conn);
			// method handles special cases for 'me' and 'here' for targetName
			controller.findPotentialMUDObject(conn, targetName, function(object) {
					// If the string 'home' is provided instead of the room number, set the 
					// target ID to my home.
					if (roomNumber === 'home')  {
						// this covers command here=home where it simply sets its temple flag
						if (targetName === 'here') { 
							object.setFlag(1<<2).success(function(){ 
								controller.sendMessage(conn, strings.homeSet);
							});
						}
						// all other cases where targetName is either an exit, room or a thing
						else {
							object.targetId = me.targetId;
							object.save();
							controller.sendMessage(conn, strings.homeSet);
						}
					}
					else {
						controller.loadMUDObject(conn, {id: roomNumber}, function(room) {
							// only continue if the number given corresponds to a room
							if (room !== null && room.type === 'ROOM') { 
								switch(object.type) {
										// for things and rooms simply set the target
										case 'THING':
										case 'ROOM':
											if (object.ownerId === me.id) {
												object.setTarget(room).success(function (){
													controller.sendMessage(conn, strings.linked);
												});
											}
											else {
												controller.sendMessage(conn, strings.permissionDenied);
											}
											break;
										// check linkOK flag before setting the target
										case 'EXIT':
											if (object.canLink) {
												// if the user isn't already the owner, make him
												if (object.ownerId !== me.id) {
													object.setOwner(me);
												}
												object.setTarget(room).success(function(){
														controller.sendMessage(conn, strings.linked);
												});
											}
											else {
												controller.sendMessage(conn, strings.permissionDenied);
											}

											break;
								}
							}
							else {
								controller.sendMessage(conn, strings.notARoom);
							}
						});
					}
			}, true, true, undefined, strings.ambigSet, undefined, false);
		}
	}),
	//Unlinks objects
	"@unlink": CommandHandler.extend({
		validate: function(conn, argsArr, cb) {
			cb(conn, argsArr);
		},
		perform: function(conn, argsArr) {
			var direction = argsArr.length===0 ? "" : argsArr[0];
			var me = controller.findActivePlayerByConnection(conn);
			controller.findPotentialMUDObject(conn, direction, function(exit) {
				// set target null if the exit is owned
				if (exit.ownerId === me.id) {
					exit.setTarget(null).success(function() {
						controller.sendMessage(conn, strings.unlinked);
					});
				}
				else {
					controller.sendMessage(conn, permissionDenied);
				}
			}, false, true, 'EXIT', strings.ambigSet, strings.unlinkUnknown, false);
		}
	}),	
	//Creates a new thing
	"@create": PropertyHandler.extend({
		prop: 'name',
		perform: function(conn, argsArr) {
			var name = argsArr.length===0 ? "" : argsArr[0];
			var me;
			if (predicates.isNameValid(name)) {
				me = controller.findActivePlayerByConnection(conn);
				// creates the object with the specified name and sets it to my location
				// with the same target ID as me and sets me as the owner
				controller.createMUDObject(conn,
					{
						name: name,
						type:'THING',
						locationId: me.id,
						targetId: me.targetId,
						ownerId: me.id
					}, function(object) {
					if (object) {
						controller.sendMessage(conn, strings.created);
					}
				});
			}
			else {
				controller.sendMessage(conn, strings.invalidName);
			}
		}
	}),
	//Unlocks the specified object
	"@unlock": CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			cb.apply(this, [conn, argsArr]);
		},
		perform: function(conn, argsArr) { 
			var objectName = argsArr.length===0 ? "" : argsArr[0]; // unknown 
			var me = controller.findActivePlayerByConnection(conn);
			controller.findPotentialMUDObject(conn, objectName, function (object) {
				if (object.ownerId === me.id) {
					// getting rid of the key unlocks the object
					object.setKey(null).success(function(){
						controller.sendMessage(conn, strings.unlocked);
					});
				}
				else {
					controller.sendMessage(conn, strings.permissionDenied);
				}
			}, true, true, undefined, strings.ambigSet, strings.unlockUnknown, false);
		}
	}),
	//Locks an object
	"@lock": CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb.apply(this, [conn, argsArr]);
			}
			else {
				controller.sendMessage(conn, strings.unknownCommand);
			}	
		},
		perform: function(conn, argsArr) {
			var index = argsArr[0].indexOf("=");
			index = (index === -1) ? argsArr[0].length : index;
			var targetName = argsArr[0].substring(0, index).trim();
			var keyName = argsArr[0].substring(index + 1).trim();
			var me = controller.findActivePlayerByConnection(conn);

			controller.findPotentialMUDObject(conn, targetName, function(target){
				if (target !== null && target.ownerId === me.id) {
					controller.findPotentialMUDObject(conn, keyName, function(key){
						if (key) {
							// setting the key locks the object
							target.setKey(key).success(function(){
								controller.sendMessage(conn, strings.locked);
							});
						}
					}, true, true, undefined, strings.ambigSet, strings.keyUnknown, false);
				}
				else {
					controller.sendMessage(conn, strings.permissionDenied);
				}
			}, true, true, undefined, strings.ambigSet, strings.lockUnknown, false);
		}
	}),
	//Examine objects
	examine: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			cb(conn, argsArr);	
		},
		perform: function(conn, argsArr) {
			var objectName = argsArr.length===0 ? "" : argsArr[0];
			var me = controller.findActivePlayerByConnection(conn);	
			controller.findPotentialMUDObject(conn, objectName, function(object) {
				if (object.ownerId === me.id) {
					controller.sendMessage(conn,strings.examine, 
						{	
							name:object.name,
							id:object.id,
							description:object.description,
							failureMessage:object.failureMessage,
							successMessage:object.successMessage,
							othersFailureMessage:object.othersFailureMessage,
							othersSuccessMessage:object.othersSuccessMessage,
							type:object.type,flags:object.flags,
							password:object.password,
							targetId:object.targetId,
							locationId:object.locationId,
							ownerId:object.ownerId,
							keyId:object.keyId
						});
					// display contents if any
					object.getContents().success(function(contents){
						if (contents.length > 0) {
							controller.sendMessage(conn, strings.contents);
							for (var i=0; i<contents.length; i++) {
								controller.sendMessage(conn, strings.examineContentsName, {type: contents[i].type, name: contents[i].name});
							}
						}
					});
				}
				else {
					controller.sendMessage(conn, strings.permissionDenied);
				}	
			}, true, true, undefined, strings.ambigSet, strings.examineUnknown, false);
		}
	}),
	//Take an object and put it in the inventory
	take: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			cb(conn, argsArr);
		},
		perform: function(conn, argsArr) {
			var thingName = argsArr.length===0 ? "" : argsArr[0];
			var me = controller.findActivePlayerByConnection(conn);
			controller.findPotentialMUDObject(conn, thingName, function(thing) {
				if (thing.ownerId === me.id) {
					// if I don't already have it see if I can take it
					if (thing.locationId !== me.id) {
						predicates.canDoIt(controller, me, thing, function (canDoIt) {
							if (canDoIt) {
								thing.setLocation(me).success(function(){
									controller.sendMessage(conn, strings.taken);
								});
							}
						}, strings.cantTakeThat);
					}
					else {
						controller.sendMessage(conn, strings.alreadyHaveThat);
					}
				}
				else {
					controller.sendMessage(conn, strings.cantTakeThat);
				}
			}, false, false, 'THING', strings.ambigSet, strings.takeUnknown, false);
		}
	}),
	//Drops the specified item 
	drop: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			cb(conn, argsArr);
		},
		perform: function(conn, argsArr) {
			var itemName = argsArr.length===0 ? "" : argsArr[0];
			var player = controller.findActivePlayerByConnection(conn);
			var foundItem = false;
			var item;

			player.getLocation().success(function (location) {
				// look through the inventory, if the object is found, set the  
				// foundItem flag to true and set the reference to the item variable
				player.getContents().success(function(objects){
					if(objects.length > 0) {
						for (var i=0; i<objects.length; i++) {
							if (itemName === objects[i].name) {
								foundItem = true;
								item = objects[i];
							}
						}
						if(foundItem) {
							var isTemple = location.isTemple();
							var hasDropTo = (location.targetId !== null);
							if (isTemple && hasDropTo) {
								item.locationId = item.targetId;
							}
							// drop the object to its home
							else if(isTemple) {
								item.locationId = item.targetId;
							}
							// drop in the current room dropto
							else if(hasDropTo) {
								item.locationId = location.targetId;
							}
							// if no flags are active, drop the object in the current room
							else {
								item.locationId = location.id;
							}
							item.save();
							controller.sendMessage(conn, strings.dropped);
						}
						else {
								controller.sendMessage(conn, strings.dontHave);
						}
					}
					else {
						controller.sendMessage(conn, strings.dontHave);
					}
				});
			});
		}
	}),
	//Set flag on object
	"@set": PropertyHandler.extend({
		nargs: 1,		
		perform: function(conn, argsArr) {
			var index = argsArr[0].indexOf("=");
			if(index === -1) {
				controller.sendMessage(conn, strings.unknownCommand);
			} 
			else {
				var indexForm = argsArr[0].indexOf("!");
				var objectName = argsArr[0].substring(0, index).trim();
				var flagName = argsArr[0].substring(index + 1).trim();
				var player = controller.findActivePlayerByConnection(conn);

				if(indexForm !== -1) {
					flagName = flagName.substring(1).trim();
				}
				if(flagName === 'anti_lock' || flagName === 'link_ok' || flagName === 'temple') {
					controller.findPotentialMUDObject(conn, objectName, function(object) {											
						if(player.id === object.ownerId) {
							var flag;
							switch (flag) {
								case 'link_ok':
									flag = 1<<0;
									break;
								case 'anti_lock':
									flag = 1<<1;
									break;
								default:
									flag = 1<<2;
							}
							// detect the "!" sign for reset
							if (indexForm === -1) {
								object.setFlag(flag).success(function() {
									controller.sendMessage(conn, strings.set, {property: "Flag"});
								});
							} else {
								object.resetFlag(flag).success(function() {
									controller.sendMessage(conn, strings.reset, {property: "Flag"});
								});
							}
						} else {
							controller.sendMessage(conn, strings.permissionDenied);
						}					 
					}, true, true, undefined, undefined, undefined, false);
				} else {
					controller.sendMessage(conn, strings.setUnknown);
				}				
			}
		}
	}),
	//Page a player 
	page: CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb(conn, argsArr);
			} else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr) {
			var recepient = controller.findActivePlayerByName(argsArr[0]);
			if (recepient) {
				var pager = controller.findActivePlayerByConnection(conn);
				var recepientConn = controller.findActiveConnectionByPlayer(recepient);
				pager.getLocation().success(function(location){
					controller.sendMessage(recepientConn, strings.page, {name: pager.name, location: location.name});
					controller.sendMessage(conn, strings.pageOK);
				});
			}
			else {
				controller.sendMessage(conn, strings.isNotAvailable);
			}
		}
	}),
	//Outputs all the objects that are like the argument
	"@find": CommandHandler.extend({
		nargs: 1,
		validate: function(conn, argsArr, cb) {
			if (argsArr.length === 1) {
				cb(conn, argsArr);
			} else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},
		perform: function(conn, argsArr) {
			var name = argsArr.length===0 ? "" : argsArr[0];
			// prints all the objects that partially match the name
			controller.loadMUDObjects(conn, {name: {like: '%' + name + '%'}}, function(objects) {
				if(objects.length > 0) {
					for(var i=0; i<objects.length; i++){
						// either you own it or it's an unlinked exit
						if(objects[i].ownerId === player.id || (objects[i].type === 'EXIT' && objects[i].targetId === null)) {
							controller.sendMessage(conn, strings.roomNameOwner, {name: objects[i].name, id: objects[i].id});	
						}
					}
				}
				else {
					controller.sendMessage(conn, strings.notFound);
				}
			}, false, false, undefined);
		}
	}),
	//Find the shortest path between current room and given location
	"@path": CommandHandler.extend({
		nargs:1, 
		validate: function(conn, argsArr, cb) {
			if(argsArr.length === 1) {
				cb(conn, argsArr);
			} else {
				controller.sendMessage(conn, strings.unknownCommand);
			}
		},	
		perform: function(conn, argsArr, errMsg) {
			var player = controller.findActivePlayerByConnection(conn);
			var destinationName = argsArr[0];		
			// continue only if the given object is a room	
			controller.loadMUDObject(conn, {name: destinationName, type: 'ROOM'}, function(destinationRoom) {
				if(destinationRoom) {
					// call bfs with first node being a vector of two integers [room, exit] - 
					// the current room and the exit used to arrive in that room
					bfs([player.locationId, null], 
					// return all exits from the current room along with the rooms that they lead to	
					function(depth, currNode, cb) {
						controller.loadMUDObject(conn, {id: currNode[0]}, function(room) {
							var neighbourRooms = [];																
							room.getContents().success(function(contents) {	
								for(var i=0; i<contents.length; i++) {
									if(contents[i].type === 'EXIT' && contents[i].targetId !== null) {
										neighbourRooms.push([contents[i].targetId, contents[i].id]);																				
									}
								}
								cb(errMsg, neighbourRooms);	
							});								
						});
					}, 
					function(nodeToValidate, cb) {							
						cb(errMsg, (nodeToValidate[0] === destinationRoom.id));							
					}, 
					function(errMsg, path) {
						// load all objects, used for printing the solutions by accessing their ids
						controller.loadMUDObjects(conn, {}, function(allObj) {
							if(path !== null) {
								if(path.length !== 0) {
									controller.sendMessage(conn, allObj[path[0][0]-1].name);
									for(var i=1; i<path.length; i++) {
										controller.sendMessage(conn, strings.via, {name: allObj[path[i][1]-1].name});
										controller.sendMessage(conn, allObj[path[i][0]-1].name);
									}
								} else {
									controller.sendMessage(conn, strings.notFound);
								}
							} else {
								controller.sendMessage(conn, strings.notFound);
							}
						});
					});					
				} else {
					controller.sendMessage(conn, strings.notFound);
				}
			});			
		}
	}),
};

//command aliases
commands.goto = commands.go;
commands.move = commands.go;
commands.cr = commands.create;
commands.co = commands.connect;
commands.get = commands.take;
commands.throw = commands.drop;
commands.read = commands.look;
commands["@fail"] = commands["@failure"];
commands["@ofail"] = commands["@ofailure"];

//The commands object is exported publicly by the module
module.exports = commands;
