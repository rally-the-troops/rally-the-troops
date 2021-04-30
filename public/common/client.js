let socket = null;
let chat_is_visible = false;
let chat_text = null;
let chat_key = null;
let chat_last_day = null;
let chat_log = null;

function scroll_with_middle_mouse(panel_sel, multiplier) {
	let panel = document.querySelector(panel_sel);
	let down_x, down_y, scroll_x, scroll_y;
	if (!multiplier)
		multiplier = 1;
	function md(e) {
		if (e.button === 1) {
			down_x = e.clientX;
			down_y = e.clientY;
			scroll_x = panel.scrollLeft;
			scroll_y = panel.scrollTop;
			window.addEventListener('mousemove', mm);
			window.addEventListener('mouseup', mu);
			e.preventDefault();
		}
	}
	function mm(e) {
		let dx = down_x - e.clientX;
		let dy = down_y - e.clientY;
		panel.scrollLeft = scroll_x + dx * multiplier;
		panel.scrollTop = scroll_y + dy * multiplier;
		e.preventDefault();
	}
	function mu(e) {
		if (e.button === 1) {
			window.removeEventListener('mousemove', mm);
			window.removeEventListener('mouseup', mu);
			e.preventDefault();
		}
	}
	panel.addEventListener('mousedown', md);
}

function drag_element_with_mouse(element_sel, grabber_sel) {
	let element = document.querySelector(element_sel);
	let grabber = document.querySelector(grabber_sel) || element;
	let save_x, save_y;
	function md(e) {
		if (e.button === 0) {
			save_x = e.clientX;
			save_y = e.clientY;
			window.addEventListener('mousemove', mm);
			window.addEventListener('mouseup', mu);
			e.preventDefault();
		}
	}
	function mm(e) {
		let dx = save_x - e.clientX;
		let dy = save_y - e.clientY;
		save_x = e.clientX;
		save_y = e.clientY;
		element.style.left = (element.offsetLeft - dx) + "px";
		element.style.top = (element.offsetTop - dy) + "px";
		e.preventDefault();
	}
	function mu(e) {
		if (e.button === 0) {
			window.removeEventListener('mousemove', mm);
			window.removeEventListener('mouseup', mu);
			e.preventDefault();
		}
	}
	grabber.addEventListener('mousedown', md);
}

function add_chat_lines(log) {
	function format_time(date) {
		let mm = date.getMinutes();
		let hh = date.getHours();
		if (mm < 10) mm = "0" + mm;
		if (hh < 10) hh = "0" + hh;
		return hh + ":" + mm;
	}
	function add_date_line(date) {
		let line = document.createElement("div");
		line.className = "date";
		line.textContent = "~ " + date + " ~";
		chat_text.appendChild(line);
	}
	function add_chat_line(time, user, message) {
		let line = document.createElement("div");
		line.textContent = "[" + time + "] " + user + " \xbb " + message;
		chat_text.appendChild(line);
		chat_text.scrollTop = chat_text.scrollHeight;
	}
	for (let entry of log) {
		chat_log.push(entry);
		let [date, user, message] = entry;
		date = new Date(date);
		let day = date.toDateString();
		if (day != chat_last_day) {
			add_date_line(day);
			chat_last_day = day;
		}
		add_chat_line(format_time(date), user, message);
	}
}

function load_chat(game) {
	chat_key = "chat/" + game;
	chat_text = document.querySelector(".chat_text");
	chat_last_day = null;
	chat_log = [];
	let save = JSON.parse(window.localStorage.getItem(chat_key));
	if (save) {
		if (Date.now() < save.expires)
			add_chat_lines(save.chat);
		else
			window.localStorage.removeItem(chat_key);
	}
	return chat_log.length;
}

function save_chat() {
	const DAY = 86400000;
	let save = { expires: Date.now() + 7 * DAY, chat: chat_log };
	window.localStorage.setItem(chat_key, JSON.stringify(save));
}

function update_chat(log_start, log) {
	if (log_start == 0) {
		chat_last_day = null;
		chat_log = [];
		while (chat_text.firstChild)
			chat_text.removeChild(chat_text.firstChild);
	}
	add_chat_lines(log);
}

function init_client(roles) {
	let params = new URLSearchParams(window.location.search);
	let title = window.location.pathname.split("/")[1];
	let game = params.get("game");
	let role = params.get("role");
	let player = null;

	const ROLE_SEL = [
		".role.one",
		".role.two",
		".role.three",
		".role.four",
		".role.five",
		".role.six",
		".role.seven",
	];

	const USER_SEL = [
		".role.one .role_user",
		".role.two .role_user",
		".role.three .role_user",
		".role.four .role_user",
		".role.five .role_user",
		".role.six .role_user",
		".role.seven .role_user",
	];

	load_chat(game);

	console.log("JOINING game", game, "role", role);

	socket = io({
		transports: ['websocket'],
		query: { title: title, game: game, role: role },
	});

	socket.on('connect', () => {
		console.log("CONNECTED");
		document.querySelector(".grid_top").classList.remove('disconnected');
		socket.emit('getchat', chat_log.length); // only send new messages when we reconnect!
	});

	socket.on('disconnect', () => {
		console.log("DISCONNECTED");
		document.getElementById("prompt").textContent = "Disconnected from server!";
		document.querySelector(".grid_top").classList.add('disconnected');
	});

	socket.on('roles', (me, players) => {
		console.log("ROLES", me, JSON.stringify(players));
		player = me;
		if (player == "Observer")
			document.querySelector(".chat_button").style.display = "none";
		document.querySelector(".grid_top").classList.add(player);
		for (let i = 0; i < roles.length; ++i) {
			let p = players.find(p => p.role == roles[i]);
			document.querySelector(USER_SEL[i]).textContent = p ? p.name : "NONE";
		}
	});

	socket.on('presence', (presence) => {
		console.log("PRESENCE", presence);
		for (let i = 0; i < roles.length; ++i) {
			let elt = document.querySelector(ROLE_SEL[i]);
			if (roles[i] in presence)
				elt.classList.add('present');
			else
				elt.classList.remove('present');
		}
	});

	socket.on('state', (state) => {
		console.log("STATE");
		on_update_log(state);
		on_update_bar(state, player);
		on_update(state, player);
	});

	socket.on('save', (msg) => {
		console.log("SAVE");
		window.localStorage[title + '/save'] = msg;
	});

	socket.on('error', (msg) => {
		console.log("ERROR", msg);
		document.getElementById("prompt").textContent = msg;
	});

	socket.on('chat', function (log_start, log) {
		console.log("CHAT UPDATE", log_start, log.length);
		update_chat(log_start, log);
		let button = document.querySelector(".chat_button");
		if (!chat_is_visible)
			button.classList.add("new");
		else
			save_chat();
	});

	document.querySelector(".chat_form").addEventListener("submit", e => {
		let input = document.querySelector("#chat_input");
		e.preventDefault();
		if (input.value) {
			socket.emit('chat', input.value);
			input.value = '';
		} else {
			hide_chat();
		}
	});

	document.querySelector("body").addEventListener("keydown", e => {
		if (player && player != "Observer") {
			if (e.key == "Escape") {
				if (chat_is_visible) {
					e.preventDefault();
					hide_chat();
				}
			}
			if (e.key == "Enter") {
				let input = document.querySelector("#chat_input");
				if (document.activeElement != input) {
					e.preventDefault();
					show_chat();
				}
			}
		}
	});

	drag_element_with_mouse(".chat_window", ".chat_header");
}

function on_update_bar(state, player) {
	document.getElementById("prompt").textContent = state.prompt;
	if (state.actions)
		document.querySelector(".grid_top").classList.add("your_turn");
	else
		document.querySelector(".grid_top").classList.remove("your_turn");
}

function on_update_log(state) {
	let parent = document.getElementById("log");
	let to_delete = parent.children.length - state.log_start;
	while (to_delete > 0) {
		parent.removeChild(parent.firstChild);
		--to_delete;
	}
	for (let entry of state.log) {
		let p = document.createElement("div");
		p.textContent = entry;
		parent.prepend(p);
	}
}

function toggle_fullscreen() {
	if (document.fullscreen)
		document.exitFullscreen();
	else
		document.documentElement.requestFullscreen();
}

function show_chat() {
	if (!chat_is_visible) {
		document.querySelector(".chat_button").classList.remove("new");
		document.querySelector(".chat_window").classList.add("show");
		document.querySelector("#chat_input").focus();
		chat_is_visible = true;
		save_chat();
	}
}

function hide_chat() {
	if (chat_is_visible) {
		document.querySelector(".chat_window").classList.remove("show");
		document.querySelector("#chat_input").blur();
		chat_is_visible = false;
	}
}

function toggle_chat() {
	if (chat_is_visible)
		hide_chat();
	else
		show_chat();
}

function toggle_log() {
	document.querySelector(".grid_window").classList.toggle("hide_log");
}

function show_action_button(sel, action, use_label = false) {
	let button = document.querySelector(sel);
	if (game.actions && action in game.actions) {
		button.classList.remove("hide");
		if (game.actions[action]) {
			if (use_label)
				button.textContent = game.actions[action];
			button.disabled = false;
		} else {
			button.disabled = true;
		}
	} else {
		button.classList.add("hide");
	}
}

function confirm_resign() {
	if (window.confirm("Are you sure that you want to resign?"))
		socket.emit('resign');
}

function send_action(verb, noun) {
	// Reset action list here so we don't send more than one action per server prompt!
	if (noun) {
		if (game.actions && game.actions[verb] && game.actions[verb].includes(noun)) {
			game.actions = null;
			console.log("SEND ACTION", verb, noun);
			socket.emit('action', verb, noun);
		}
	} else {
		if (game.actions && game.actions[verb]) {
			game.actions = null;
			console.log("SEND ACTION", verb, noun);
			socket.emit('action', verb);
		}
	}
}

function send_save() {
	socket.emit('save');
}

function send_restore() {
	let title = window.location.pathname.split("/")[1];
	let save = window.localStorage[title + '/save'];
	socket.emit('restore', window.localStorage[title + '/save']);
}

function send_restart(scenario) {
	socket.emit('restart', scenario);
}