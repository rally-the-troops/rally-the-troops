"use strict";

const fs = require('fs');
const express = require('express');
const express_session = require('express-session');
const passport = require('passport');
const passport_local = require('passport-local');
const passport_socket = require('passport.socketio');
const body_parser = require('body-parser');
const connect_flash = require('connect-flash');
const crypto = require('crypto');
const sqlite3 = require('better-sqlite3');
const SQLiteStore = require('./connect-better-sqlite3')(express_session);

require('dotenv').config();

const SESSION_SECRET = "Caesar has a big head!";

const MAX_OPEN_GAMES = 3;

let sessionStore = new SQLiteStore();
let db = new sqlite3(process.env.DATABASE || "./db");
let app = express();
let http_port = process.env.PORT || 8080;
let https_port = process.env.HTTPS_PORT || 8443;
let http = require('http').createServer(app);
let https = require('https').createServer({
	key: fs.readFileSync(process.env.SSL_KEY || "key.pem"),
	cert: fs.readFileSync(process.env.SSL_CERT || "cert.pem")
	}, app);
let socket_io = require('socket.io');
let io1 = socket_io(http);
let io2 = socket_io(https);
let io = {
	use: function (fn) { io1.use(fn); io2.use(fn); },
	on: function (ev,fn) { io1.on(ev,fn); io2.on(ev,fn); },
};

app.disable('etag');
app.set('view engine', 'ejs');
app.use(body_parser.urlencoded({extended:false}));
app.use(express_session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: true,
	store: sessionStore,
	cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(connect_flash());

io.use(passport_socket.authorize({
	key: 'connect.sid',
	secret: SESSION_SECRET,
	store: sessionStore,
}));

const is_immutable = /\.(svg|png|jpg|jpeg|woff2)$/;

function setHeaders(res, path) {
        if (is_immutable.test(path))
                res.set("Cache-Control", "public, max-age=86400, immutable");
}

app.use(express.static('public', { setHeaders: setHeaders }));

function LOG(req, ...msg) {
	let name;
	if (req.isAuthenticated())
		name = req.user.mail;
	else
		name = "guest";
	let time = new Date().toISOString().substring(0,19).replace("T", " ");
	console.log(time, req.connection.remoteAddress, name, ...msg);
}

function SLOG(socket, ...msg) {
	let name = socket.request.user.mail;
	let time = new Date().toISOString().substring(0,19).replace("T", " ");
	console.log(time, socket.request.connection.remoteAddress, name,
		socket.id, socket.title_id, socket.game_id, socket.role, ...msg);
}

function human_date(time) {
	var date = time ? new Date(time + " UTC") : new Date(0);
	var seconds = (Date.now() - date.getTime()) / 1000;
	var days = Math.floor(seconds / 86400);
	if (days == 0) {
		if (seconds < 60) return "now";
		if (seconds < 120) return "1 minute ago";
		if (seconds < 3600) return Math.floor(seconds / 60) + " minutes ago";
		if (seconds < 7200) return "1 hour ago";
		if (seconds < 86400) return Math.floor(seconds / 3600) + " hours ago";
	}
	if (days == 1) return "Yesterday";
	if (days < 14) return days + " days ago";
	if (days < 31) return Math.ceil(days / 7) + " weeks ago";
	return date.toISOString().substring(0,10);
}

function humanize(rows) {
	for (let row of rows) {
		row.ctime = human_date(row.ctime);
		row.mtime = human_date(row.mtime);
	}
}

function is_email(email) {
	return email.match(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/);
}

function clean_user_name(name) {
	name = name.replace(/^ */,'').replace(/ *$/,'').replace(/  */g,' ');
	if (name.length > 50)
		name = name.substring(0, 50);
	return name;
}

function hash_password(password, salt) {
	let hash = crypto.createHash('sha256');
	hash.update(password);
	hash.update(salt);
	return hash.digest('hex');
}

function get_avatar(mail) {
	if (!mail)
		mail = "foo@example.com";
	let digest = crypto.createHash('md5').update(mail.trim().toLowerCase()).digest('hex');
	return '//www.gravatar.com/avatar/' + digest + '?d=mp';
}

/*
 * USER PROFILES
 */

const sql_blacklist_ip = db.prepare("SELECT COUNT(*) FROM blacklist_ip WHERE ip = ?").raw();
const sql_blacklist_mail = db.prepare("SELECT COUNT(*) AS count FROM blacklist_mail WHERE ? LIKE mail").raw();

function is_blacklisted(ip, mail) {
	if (sql_blacklist_ip.get(ip)[0] != 0)
		return true;
	if (sql_blacklist_mail.get(mail)[0] != 0)
		return true;
	return false;
}

const sql_deserialize_user = db.prepare("SELECT user_id, name, mail FROM users WHERE user_id = ?");
const sql_update_last_seen = db.prepare("UPDATE users SET aip = ?, atime = datetime('now') WHERE user_id = ?");
const sql_login_select = db.prepare("SELECT user_id, name, mail, password, salt FROM users WHERE name = ? OR mail = ?");

passport.serializeUser(function (user, done) {
	return done(null, user.user_id);
});

passport.deserializeUser(function (user_id, done) {
	try {
		let row = sql_deserialize_user.get(user_id);
		if (!row)
			return done(null, false);
		return done(null, row);
	} catch (err) {
		console.log(err);
		return done(null, false);
	}
});

function local_login(req, name_or_mail, password, done) {
	try {
		if (!is_email(name_or_mail))
			name_or_mail = clean_user_name(name_or_mail);
		LOG(req, "POST /login", name_or_mail);
		let row = sql_login_select.get(name_or_mail, name_or_mail);
		if (!row)
			return setTimeout(() => done(null, false, req.flash('message', "User not found.")), 1000);
		if (is_blacklisted(req.connection.remoteAddress, row.mail))
			return setTimeout(() => done(null, false, req.flash('message', "Sorry, but this IP or account has been banned.")), 1000);
		let hash = hash_password(password, row.salt);
		if (hash != row.password)
			return setTimeout(() => done(null, false, req.flash('message', "Wrong password.")), 1000);
		sql_update_last_seen.run(req.connection.remoteAddress, row.user_id);
		done(null, row);
	} catch (err) {
		done(null, false, req.flash('message', err.toString()));
	}
}

const sql_signup_check = db.prepare("SELECT user_id, name FROM users WHERE name = ? OR mail = ?");
const sql_signup_insert = db.prepare("INSERT INTO users (name, mail, password, salt, ctime, cip, atime, aip) VALUES (?,?,?,?,datetime('now'),?,datetime('now'),?)");
const sql_signup_login = db.prepare("SELECT user_id, name FROM users WHERE name = ? AND password = ?");

function local_signup(req, name, password, done) {
	try {
		let mail = req.body.mail;
		name = clean_user_name(name);
		LOG(req, "POST /signup", name, mail);
		if (is_blacklisted(req.connection.remoteAddress, mail))
			return setTimeout(() => done(null, false, req.flash('message', "Sorry, but this IP or account has been banned.")), 1000);
		if (password.length < 4)
			return done(null, false, req.flash('message', "Password is too short!"));
		if (password.length > 100)
			return done(null, false, req.flash('message', "Password is too long!"));
		// TODO: actual verification if process.env.VERIFY_EMAIL
		if (!is_email(mail))
			return done(null, false, req.flash('message', "Invalid mail address!"));
		let row = sql_signup_check.get(name, mail);
		if (row)
			return done(null, false, req.flash('message', "User name or mail is already taken."));
		let salt = crypto.randomBytes(32).toString('hex');
		let hash = hash_password(password, salt);
		let ip = req.connection.remoteAddress;
		sql_signup_insert.run(name, mail, hash, salt, ip, ip);
		row = sql_signup_login.get(name, hash);
		done(null, row);
	} catch (err) {
		done(null, false, req.flash('message', err.toString()));
	}
}

passport.use('local-login', new passport_local.Strategy({ passReqToCallback: true }, local_login));
passport.use('local-signup', new passport_local.Strategy({ passReqToCallback: true }, local_signup));

app.use(passport.initialize());
app.use(passport.session());

function update_last_seen(req) {
	sql_update_last_seen.run(req.connection.remoteAddress, req.user.user_id);
}

function must_be_logged_in(req, res, next) {
	if (!req.isAuthenticated())
		return res.redirect('/login');
	if (sql_blacklist_ip.get(req.connection.remoteAddress)[0] != 0)
		return res.redirect('/banned');
	if (sql_blacklist_mail.get(req.user.mail)[0] != 0)
		return res.redirect('/banned');
	update_last_seen(req);
	return next();
}

app.get('/favicon.ico', function (req, res) {
	res.status(204).send();
});

app.get('/about', function (req, res) {
	res.render('about.ejs', { user: req.user });
});

app.get('/logout', function (req, res) {
	LOG(req, "GET /logout");
	req.logout();
	res.redirect('/login');
});

app.get('/banned', function (req, res) {
	LOG(req, "GET /banned");
	res.render('banned.ejs', { user: req.user, message: req.flash('message') });
});

app.get('/login', function (req, res) {
	LOG(req, "GET /login");
	res.render('login.ejs', { user: req.user, message: req.flash('message') });
});

app.get('/signup', function (req, res) {
	LOG(req, "GET /signup");
	res.render('signup.ejs', { user: req.user, message: req.flash('message') });
});

app.post('/login',
	passport.authenticate('local-login', {
		successRedirect: '/',
		failureRedirect: '/login',
		failureFlash: true
	})
);

app.post('/signup',
	passport.authenticate('local-signup', {
		successRedirect: '/',
		failureRedirect: '/signup',
		failureFlash: true
	})
);

app.get('/users', function (req, res) {
	LOG(req, "GET /users");
	let rows = db.prepare("SELECT name, mail, ctime, atime FROM users ORDER BY atime DESC").all();
	rows.forEach(row => {
		row.avatar = get_avatar(row.mail);
		row.ctime = human_date(row.ctime);
		row.atime = human_date(row.atime);
	});
	res.render('users.ejs', { user: req.user, message: req.flash('message'), userList: rows });
});

app.get('/change_password', must_be_logged_in, function (req, res) {
	LOG(req, "GET /change_password");
	res.render('change_password.ejs', { user: req.user, message: req.flash('message') });
});

app.post('/change_password', must_be_logged_in, function (req, res) {
	try {
		let name = clean_user_name(req.user.name);
		let password = req.body.password;
		let newpass = req.body.newpass;
		LOG(req, "POST /change_password", name);
		if (newpass.length < 4) {
			req.flash('message', "Password is too short!");
			return res.redirect('/change_password');
		}
		let salt_row = db.prepare("SELECT salt FROM users WHERE name = ?").get(name);
		if (!salt_row) {
			req.flash('message', "User not found.");
			return res.redirect('/change_password');
		}
		let salt = salt_row.salt;
		let hash = hash_password(password, salt);
		let user_row = db.prepare("SELECT user_id, name FROM users WHERE name = ? AND password = ?").get(name, hash);
		if (!user_row) {
			req.flash('message', "Wrong password.");
			return res.redirect('/change_password');
		}
		hash = hash_password(newpass, salt);
		db.prepare("UPDATE users SET password = ? WHERE user_id = ?").run(hash, user_row.user_id);
		return res.redirect('/profile');
	} catch (err) {
		console.log(err);
		req.flash('message', err.message);
		return res.redirect('/change_password');
	}
});

/*
 * GAME LOBBY
 */

let RULES = {};
for (let title_id of db.prepare("SELECT * FROM titles").pluck().all()) {
	console.log("Loading rules for " + title_id);
	try {
		RULES[title_id] = require("./public/" + title_id + "/rules.js");
	} catch (err) {
		console.log(err);
	}
}

const QUERY_LIST_ONE_GAME = db.prepare(`
	SELECT
		games.game_id,
		games.title_id AS title_id,
		titles.title_name AS title_name,
		games.scenario AS scenario,
		games.owner AS owner_id,
		users.name AS owner_name,
		games.ctime,
		games.mtime,
		games.description,
		games.status,
		games.result,
		games.active
	FROM games
	JOIN users ON games.owner = users.user_id
	JOIN titles ON games.title_id = titles.title_id
	WHERE game_id = ?
`);

const QUERY_LIST_PUBLIC_GAMES = db.prepare(`
	SELECT
		games.game_id,
		games.title_id AS title_id,
		games.scenario AS scenario,
		games.owner AS owner_id,
		users.name AS owner_name,
		games.ctime,
		games.mtime,
		games.description,
		games.status,
		games.result,
		games.active
	FROM games
	JOIN users ON games.owner = users.user_id
	WHERE title_id = ? AND private = 0
	ORDER BY status ASC, mtime DESC
`);

const QUERY_LIST_USER_GAMES = db.prepare(`
	SELECT DISTINCT
		games.game_id,
		games.title_id,
		titles.title_name,
		games.scenario AS scenario,
		users.name AS owner_name,
		games.description,
		games.ctime,
		games.mtime,
		games.status,
		games.result,
		games.active
	FROM games
	LEFT JOIN players ON games.game_id = players.game_id
	LEFT JOIN users ON games.owner = users.user_id
	LEFT JOIN titles ON games.title_id = titles.title_id
	WHERE games.owner = ? OR players.user_id = ?
	ORDER BY status ASC, mtime DESC
`);

const QUERY_LIST_ALL_GAMES = db.prepare(`
	SELECT
		games.game_id,
		games.title_id AS title_id,
		titles.title_name,
		games.scenario AS scenario,
		games.owner AS owner_id,
		users.name AS owner_name,
		games.ctime,
		games.mtime,
		games.description,
		games.status,
		games.result,
		games.active,
		games.private
	FROM games
	JOIN users ON games.owner = users.user_id
	LEFT JOIN titles ON games.title_id = titles.title_id
	ORDER BY status ASC, mtime DESC
`);

const QUERY_PLAYERS = db.prepare(`
	SELECT
		players.game_id,
		players.user_id,
		players.role,
		users.name
	FROM players
	JOIN users ON players.user_id = users.user_id
	WHERE players.game_id = ?
`);

const QUERY_PLAYER_NAMES = db.prepare(`
	SELECT
		users.name AS name
	FROM players
	JOIN users ON players.user_id = users.user_id
	WHERE players.game_id = ?
	ORDER BY players.role
`).pluck();

const QUERY_TITLE = db.prepare("SELECT * FROM titles WHERE title_id = ?");
const QUERY_ROLES = db.prepare("SELECT * FROM roles WHERE title_id = ?");
const QUERY_GAME_OWNER = db.prepare("SELECT * FROM games WHERE game_id = ? AND owner = ?");
const QUERY_TITLE_FROM_GAME = db.prepare("SELECT title_id FROM games WHERE game_id = ?");
const QUERY_ROLE_FROM_GAME_AND_USER = db.prepare("SELECT role FROM players WHERE game_id = ? AND user_id = ?");

const QUERY_JOIN_GAME = db.prepare("INSERT INTO players (user_id, game_id, role) VALUES (?,?,?)");
const QUERY_PART_GAME = db.prepare("DELETE FROM players WHERE game_id = ? AND user_id = ? AND role = ?");
const QUERY_START_GAME = db.prepare("UPDATE games SET status = 1, state = ?, active = ? WHERE game_id = ?");
const QUERY_CREATE_GAME = db.prepare(`
	INSERT INTO games
	(owner,title_id,scenario,private,ctime,mtime,description,status,state,chat)
	VALUES
	(?,?,?,?,datetime('now'),datetime('now'),?,0,NULL,'[]')
`);
const QUERY_UPDATE_GAME_SET_PRIVATE = db.prepare("UPDATE games SET private = 1 WHERE game_id = ?");

const QUERY_IS_PLAYER = db.prepare("SELECT COUNT(*) FROM players WHERE game_id = ? AND user_id = ?").pluck();
const QUERY_IS_ACTIVE = db.prepare("SELECT COUNT(*) FROM players WHERE game_id = ? AND role = ? AND user_id = ?").pluck();
const QUERY_COUNT_OPEN_GAMES = db.prepare("SELECT COUNT(*) FROM games WHERE owner = ? AND status = 0").pluck();
const QUERY_DELETE_GAME = db.prepare("DELETE FROM games WHERE game_id = ?");

app.get('/', function (req, res) {
	res.render('index.ejs', { user: req.user, message: req.flash('message') });
});

function is_your_turn(game, user) {
	if (!game.active || game.active == "None")
		return false;
	if (game.active == "All" || game.active == "Both")
		return QUERY_IS_PLAYER.get(game.game_id, user.user_id);
	return QUERY_IS_ACTIVE.get(game.game_id, game.active, user.user_id);
}

app.get('/profile', must_be_logged_in, function (req, res) {
	LOG(req, "GET /profile");
	let avatar = get_avatar(req.user.mail);
	let games = QUERY_LIST_USER_GAMES.all(req.user.user_id, req.user.user_id);
	humanize(games);
	for (let game of games) {
		game.players = QUERY_PLAYER_NAMES.all(game.game_id);
		game.your_turn = is_your_turn(game, req.user);
	}
	let open_games = games.filter(game => game.status == 0);
	let active_games = games.filter(game => game.status == 1);
	let finished_games = games.filter(game => game.status == 2);
	res.set("Cache-Control", "no-store");
	res.render('profile.ejs', { user: req.user, avatar: avatar,
		open_games: open_games,
		active_games: active_games,
		finished_games: finished_games,
		message: req.flash('message')
	});
});

app.get('/info/:title_id', function (req, res) {
	LOG(req, "GET /info/" + req.params.title_id);
	let title_id = req.params.title_id;
	let title = QUERY_TITLE.get(title_id);
	if (!title) {
		req.flash('message', 'That title does not exist.');
		return res.redirect('/');
	}
	if (req.isAuthenticated()) {
		let games = QUERY_LIST_PUBLIC_GAMES.all(title_id);
		humanize(games);
		let open_games = games.filter(game => game.status == 0);
		let active_games = games.filter(game => game.status == 1);
		for (let game of active_games) {
			game.players = QUERY_PLAYER_NAMES.all(game.game_id);
			game.your_turn = is_your_turn(game, req.user);
		}
		let finished_games = games.filter(game => game.status == 2);
		for (let game of finished_games)
			game.players = QUERY_PLAYER_NAMES.all(game.game_id);
		res.set("Cache-Control", "no-store");
		res.render('info.ejs', { user: req.user, title: title,
			open_games: open_games,
			active_games: active_games,
			finished_games: finished_games,
			message: req.flash('message')
		});
	} else {
		res.set("Cache-Control", "no-store");
		res.render('info.ejs', { user: req.user, title: title,
			open_games: [],
			active_games: [],
			finished_games: [],
			message: req.flash('message')
		});
	}
});

app.get('/create/:title_id', must_be_logged_in, function (req, res) {
	LOG(req, "GET /create/" + req.params.title_id);
	let title_id = req.params.title_id;
	let title = QUERY_TITLE.get(title_id);
	if (!title) {
		req.flash('message', 'That title does not exist.');
		return res.redirect('/');
	}
	res.render('create.ejs', { user: req.user, message: req.flash('message'), title: title, scenarios: RULES[title_id].scenarios });
});

app.post('/create/:title_id', must_be_logged_in, function (req, res) {
	let title_id = req.params.title_id;
	let descr = req.body.description;
	let priv = req.body.private == 'private';
	let scenario = req.body.scenario;
	let user_id = req.user.user_id;
	LOG(req, "POST /create/" + req.params.title_id, scenario, priv, JSON.stringify(descr));
	try {
		let count = QUERY_COUNT_OPEN_GAMES.get(user_id);
		if (count >= MAX_OPEN_GAMES) {
			req.flash('message', "You have too many open games!");
			return res.redirect('/create/'+title_id);
		}
		if (!(title_id in RULES)) {
			req.flash('message', "That title doesn't exist.");
			return res.redirect('/');
		}
		if (!RULES[title_id].scenarios.includes(scenario)) {
			req.flash('message', "That scenario doesn't exist.");
			return res.redirect('/create/'+title_id);
		}
		let info = QUERY_CREATE_GAME.run(user_id, title_id, scenario, priv ? 1 : 0, descr);
		res.redirect('/join/'+info.lastInsertRowid);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/create/'+title_id);
	}
});

app.get('/delete/:game_id', must_be_logged_in, function (req, res) {
	let game_id = req.params.game_id;
	LOG(req, "GET /delete/" + game_id);
	try {
		let game = QUERY_GAME_OWNER.get(game_id, req.user.user_id);
		if (!game) {
			req.flash('message', "Only the game owner can delete the game!");
			return res.redirect('/join/'+game_id);
		}
		QUERY_DELETE_GAME.run(game_id);
		res.redirect('/info/'+game.title_id);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

app.get('/join/:game_id', must_be_logged_in, function (req, res) {
	LOG(req, "GET /join/" + req.params.game_id);
	let game_id = req.params.game_id | 0;
	let game = QUERY_LIST_ONE_GAME.get(game_id);
	if (!game) {
		req.flash('message', "That game doesn't exist.");
		return res.redirect('/');
	}
	let roles = QUERY_ROLES.all(game.title_id);
	let players = QUERY_PLAYERS.all(game_id);
	res.set("Cache-Control", "no-store");
	res.render('join.ejs', {
		user: req.user,
		game: game,
		roles: roles,
		players: players,
		solo: players.every(p => p.user_id == req.user.user_id),
		message: req.flash('message')
	});
});

app.get('/join/:game_id/:role', must_be_logged_in, function (req, res) {
	LOG(req, "GET /join/" + req.params.game_id + "/" + req.params.role);
	let game_id = req.params.game_id | 0;
	let role = req.params.role;
	try {
		QUERY_JOIN_GAME.run(req.user.user_id, game_id, role);
		return res.redirect('/join/'+game_id);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

app.get('/part/:game_id/:part_id/:role', must_be_logged_in, function (req, res) {
	LOG(req, "GET /part/" + req.params.game_id + "/" + req.params.part_id + "/" + req.params.role);
	let game_id = req.params.game_id | 0;
	let part_id = req.params.part_id | 0;
	let role = req.params.role;
	try {
		QUERY_PART_GAME.run(game_id, part_id, role);
		return res.redirect('/join/'+game_id);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

app.get('/start/:game_id', must_be_logged_in, function (req, res) {
	LOG(req, "GET /start/" + req.params.game_id);
	let game_id = req.params.game_id | 0;
	try {
		let game = QUERY_GAME_OWNER.get(game_id, req.user.user_id);
		if (!game) {
			req.flash('message', "Only the game owner can start the game!");
			return res.redirect('/join/'+game_id);
		}
		if (game.status != 0) {
			req.flash('message', "The game is already started!");
			return res.redirect('/join/'+game_id);
		}
		let players = QUERY_PLAYERS.all(game_id);
		let state = RULES[game.title_id].setup(game.scenario, players);
		QUERY_START_GAME.run(JSON.stringify(state), state.active, game_id);
		let is_solo = players.every(p => p.user_id == players[0].user_id);
		if (is_solo)
			QUERY_UPDATE_GAME_SET_PRIVATE.run(game_id);
		return res.redirect('/join/'+game_id);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

app.get('/play/:game_id/:role', must_be_logged_in, function (req, res) {
	LOG(req, "GET /play/" + req.params.game_id + "/" + req.params.role);
	let game_id = req.params.game_id | 0;
	let role = req.params.role;
	try {
		let title = QUERY_TITLE_FROM_GAME.get(game_id);
		if (!title)
			return res.redirect('/join/'+game_id);
		res.redirect('/'+title.title_id+'/play.html?game='+game_id+'&role='+role);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

app.get('/play/:game_id', must_be_logged_in, function (req, res) {
	LOG(req, "GET /play/" + req.params.game_id);
	let game_id = req.params.game_id | 0;
	let user_id = req.user.user_id | 0;
	try {
		let role = QUERY_ROLE_FROM_GAME_AND_USER.get(game_id, user_id);
		if (!role)
			return res.redirect('/play/'+game_id+'/Observer');
		return res.redirect('/play/'+game_id+'/'+role.role);
	} catch (err) {
		req.flash('message', err.toString());
		return res.redirect('/join/'+game_id);
	}
});

/*
 * GAME PLAYING
 */

const QUERY_SELECT_CHAT = db.prepare("SELECT chat FROM games WHERE game_id = ?");
const QUERY_UPDATE_CHAT = db.prepare("UPDATE games SET chat = ? WHERE game_id = ?");
const QUERY_SELECT_GAME_STATE = db.prepare("SELECT state FROM games WHERE game_id = ?");
const QUERY_UPDATE_GAME_STATE = db.prepare("UPDATE games SET state = ?, active = ?, status = ?, result = ?, mtime = datetime('now') WHERE game_id = ?");
const QUERY_CONNECT_GAME = db.prepare("SELECT title_id, state FROM games WHERE title_id = ? AND game_id = ?");
const QUERY_RESTART_GAME = db.prepare("UPDATE games SET state = ?, mtime = datetime('now') WHERE game_id = ?");

let clients = {};

function send_state(socket, state) {
	try {
		let view = socket.rules.view(state, socket.role);
		if (socket.log_length < view.log.length)
			view.log_start = socket.log_length;
		else
			view.log_start = view.log.length;
		socket.log_length = view.log.length;
		view.log = view.log.slice(view.log_start);
		socket.emit('state', view);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function get_game_state(game_id) {
	let row = QUERY_SELECT_GAME_STATE.get(game_id);
	if (!row)
		throw new Error("No game with that ID");
	return JSON.parse(row.state);
}

function put_game_state(game_id, state) {
	let status = 1;
	let result = null;
	if (state.state == 'game_over') {
		status = 2;
		result = state.result;
	}
	QUERY_UPDATE_GAME_STATE.run(JSON.stringify(state), state.active, status, result, game_id);
	for (let other of clients[game_id])
		send_state(other, state);
}

function on_action(socket, action, arg) {
	SLOG(socket, "--> ACTION", action, arg);
	try {
		let state = get_game_state(socket.game_id);
		socket.rules.action(state, socket.role, action, arg);
		put_game_state(socket.game_id, state);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function on_resign(socket) {
	SLOG(socket, "--> RESIGN");
	try {
		let state = get_game_state(socket.game_id);
		socket.rules.resign(state, socket.role);
		put_game_state(socket.game_id, state);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function send_chat(socket, chat) {
	if (chat && socket.chat_length < chat.length) {
		SLOG(socket, "<-- CHAT LOG", socket.chat_length, "..", chat.length);
		socket.emit('chat', socket.chat_length, chat.slice(socket.chat_length));
		socket.chat_length = chat.length;
	}
}

function on_getchat(socket, old_len) {
	try {
		socket.chat_length = old_len;
		let row = QUERY_SELECT_CHAT.get(socket.game_id);
		if (!row)
			return socket.emit('error', "No game with that ID.");
		let chat = JSON.parse(row.chat);
		if (!chat)
			chat = [];
		send_chat(socket, chat);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function on_chat(socket, message) {
	message = message.substring(0,4096);
	SLOG(socket, "--> CHAT");
	try {
		let row = QUERY_SELECT_CHAT.get(socket.game_id);
		if (!row)
			return socket.emit('error', "No game with that ID.");
		let chat = JSON.parse(row.chat);
		if (!chat)
			chat = [];
		chat.push([new Date(), socket.user_name, message]);
		QUERY_UPDATE_CHAT.run(JSON.stringify(chat), socket.game_id);
		for (let other of clients[socket.game_id])
			send_chat(other, chat);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function on_debug(socket) {
	SLOG(socket, "<-- DEBUG");
	try {
		let row = QUERY_SELECT_GAME_STATE.get(socket.game_id);
		if (!row)
			return socket.emit('error', "No game with that ID.");
		socket.emit('debug', row.state);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function on_save(socket) {
	SLOG(socket, "<-- SAVE");
	try {
		let row = QUERY_SELECT_GAME_STATE.get(socket.game_id);
		if (!row)
			return socket.emit('error', "No game with that ID.");
		socket.emit('save', row.state);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function on_restore(socket, state_text) {
	SLOG(socket, '--> RESTORE', state_text);
	try {
		let state = JSON.parse(state_text);
		QUERY_UPDATE_GAME_STATE.run(state_text, state.active, 1, null, socket.game_id);
		for (let other of clients[socket.game_id])
			send_state(other, state);
	} catch (err) {
		console.log(err);
		return socket.emit('error', err.toString());
	}
}

function broadcast_presence(game_id) {
	let presence = {};
	for (let socket of clients[game_id])
		presence[socket.role] = true;
	for (let socket of clients[game_id])
		socket.emit('presence', presence);
}

io.on('connection', (socket) => {
	socket.title_id = socket.handshake.query.title;
	socket.game_id = socket.handshake.query.game | 0;
	socket.user_id = socket.request.user.user_id | 0;
	socket.user_name = socket.request.user.name;
	socket.role = socket.handshake.query.role;
	socket.log_length = 0;
	socket.chat_length = 0;
	socket.rules = RULES[socket.title_id];

	SLOG(socket, "CONNECT");

	try {
		let game = QUERY_CONNECT_GAME.get(socket.title_id, socket.game_id);
		if (!game)
			return socket.emit('error', "That game does not exist.");

		let players = QUERY_PLAYERS.all(socket.game_id);

		if (socket.role != "Observer") {
			let me;
			if (socket.role && socket.role != 'undefined' && socket.role != 'null') {
				me = players.find(p => p.user_id == socket.user_id && p.role == socket.role);
				if (!me) {
					socket.role = "Observer";
					return socket.emit('error', "You aren't assigned that role!");
				}
			} else {
				me = players.find(p => p.user_id == socket.user_id);
				socket.role = me ? me.role : "Observer";
			}
		}

		socket.emit('roles', socket.role, players);

		if (clients[socket.game_id])
			clients[socket.game_id].push(socket);
		else
			clients[socket.game_id] = [ socket ];

		socket.on('disconnect', () => {
			SLOG(socket, "DISCONNECT");
			clients[socket.game_id].splice(clients[socket.game_id].indexOf(socket), 1);
			if (socket.role != "Observer")
				broadcast_presence(socket.game_id);
		});

		if (socket.role != "Observer") {
			socket.on('action', (action, arg) => on_action(socket, action, arg));
			socket.on('resign', () => on_resign(socket));
			socket.on('getchat', (old_len) => on_getchat(socket, old_len));
			socket.on('chat', (message) => on_chat(socket, message));

			socket.on('debug', () => on_debug(socket));
			socket.on('save', () => on_save(socket));
			socket.on('restore', (state) => on_restore(socket, state));
			socket.on('restart', (scenario) => {
				let state = socket.rules.setup(scenario, players);
				for (let other of clients[socket.game_id]) {
					other.log_length = 0;
					send_state(other, state);
				}
				let state_text = JSON.stringify(state);
				QUERY_RESTART_GAME.run(state_text, socket.game_id);
			});
		}

		broadcast_presence(socket.game_id);

		send_state(socket, JSON.parse(game.state));

	} catch (err) {
		console.log(err);
		socket.emit('error', err.message);
	}
});

http.listen(http_port, '0.0.0.0', () => { console.log('listening HTTP on *:' + http_port); });
https.listen(https_port, '0.0.0.0', () => { console.log('listening HTTPS on *:' + https_port); });