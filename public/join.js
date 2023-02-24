"use strict"

let start_status = game.status
let evtsrc = null
let timer = 0

function confirm_delete() {
	let warning = `Are you sure you want to DELETE this game?`
	if (window.confirm(warning))
		window.location.href = "/delete/" + game.game_id
}

function post(url) {
	fetch(url, { method: "POST" })
		.then(r => r.text())
		.then(t => window.error.textContent = (t === "SUCCESS") ? "" : t)
		.catch(e => window.error.textContent = e)
	start_event_source()
}

function start() {
	post(`/start/${game.game_id}`)
}

function join(role) {
	post(`/join/${game.game_id}/${encodeURIComponent(role)}`)
}

function part(role) {
	let warning = "Are you sure you want to LEAVE this game?"
	if (game.status === 0 || window.confirm(warning))
		post(`/part/${game.game_id}/${encodeURIComponent(role)}`)
}

function kick(role) {
	let player = players.find(p => p.role === role)
	let warning = `Are you sure you want to KICK player ${player.name} (${role}) from this game?`
	if (game.status === 0 || window.confirm(warning))
		post(`/part/${game.game_id}/${encodeURIComponent(role)}`)
}

let blink_title = document.title
let blink_timer = 0

function start_blinker(message) {
	let tick = false
	if (blink_timer)
		stop_blinker()
	if (!document.hasFocus()) {
		document.title = message
		blink_timer = setInterval(function () {
			document.title = tick ? message : blink_title
			tick = !tick
		}, 1000)
	}
}

function stop_blinker() {
	document.title = blink_title
	clearInterval(blink_timer)
	blink_timer = 0
}

window.addEventListener("focus", stop_blinker)

function start_event_source() {
	if (!evtsrc || evtsrc.readyState === 2) {
		console.log("STARTING EVENT SOURCE")
		evtsrc = new EventSource("/join-events/" + game.game_id)
		evtsrc.addEventListener("players", function (evt) {
			console.log("PLAYERS:", evt.data)
			players = JSON.parse(evt.data)
			update()
		})
		evtsrc.addEventListener("ready", function (evt) {
			console.log("READY:", evt.data)
			ready = JSON.parse(evt.data)
			update()
		})
		evtsrc.addEventListener("game", function (evt) {
			console.log("GAME:", evt.data)
			game = JSON.parse(evt.data)
			if (game.status > 1) {
				clearInterval(timer)
				evtsrc.close()
			}
			update()
		})
		evtsrc.addEventListener("deleted", function (evt) {
			console.log("DELETED")
			window.location.href = '/' + game.title_id
		})
		evtsrc.onerror = function (err) {
			window.message.innerHTML = "Disconnected from server..."
		}
		window.addEventListener('beforeunload', function (evt) {
			evtsrc.close()
		})
	}
}

function is_friend(p) {
	return whitelist.includes(p.user_id)
}

function is_enemy(p) {
	return blacklist.includes(p.user_id)
}

function is_active(player, role) {
	return (game.active === role || game.active === "Both" || game.active === "All")
}

function is_solo() {
	return players.every(p => p.user_id === players[0].user_id)
}

function update() {
	for (let i = 0; i < roles.length; ++i) {
		let role = roles[i]
		let role_id = "role_" + role.replace(/ /g, "_")
		if (game.is_random && game.status === 0)
			role = "Random " + (i+1)
		document.getElementById(role_id + "_name").textContent = role
		let player = players.find(p => p.role === role)
		let element = document.getElementById(role_id)
		if (player) {
			switch (game.status) {
			case 2:
				if (player.user_id === user_id)
					element.innerHTML = `<a href="/${game.title_id}/play.html?game=${game.game_id}&role=${encodeURIComponent(role)}">${player.name}</a>`
				else
					element.innerHTML = player.name
				break
			case 1:
				element.classList.toggle("is_active", is_active(player, role))
				if (player.user_id === user_id)
					element.innerHTML = `<a href="/${game.title_id}/play.html?game=${game.game_id}&role=${encodeURIComponent(role)}">${player.name}</a><a class="red" href="javascript:part('${role}')">\u274c</a>`
				else if (game.owner_id === user_id)
					element.innerHTML = `${player.name}<a class="red" href="javascript:kick('${role}')">\u274c</a>`
				else
					element.innerHTML = player.name
				break
			case 0:
				if (player.user_id === user_id)
					element.innerHTML = `${player.name}<a class="red" href="javascript:part('${role}')">\u274c</a>`
				else if (game.owner_id === user_id)
					element.innerHTML = `${player.name}<a class="red" href="javascript:kick('${role}')">\u274c</a>`
				else
					element.innerHTML = player.name
				break
			}
			element.classList.toggle("friend", is_friend(player))
			element.classList.toggle("enemy", is_enemy(player))
			if (is_enemy(player))
				element.title = "You have blacklisted this user!"
			else
				element.title = ""
		} else {
			switch (game.status) {
			case 2:
				element.innerHTML = `<i>Empty</i>`
				break
			case 1:
			case 0:
				element.innerHTML = `<a class="join" href="javascript:join('${role}')">Join</a>`
				break
			}
			element.classList.remove("friend")
			element.classList.remove("enemy")
			element.title = ""
		}
	}

	let message = window.message
	if (game.status === 0) {
		if (ready && (game.owner_id === user_id))
			message.innerHTML = "Ready to start..."
		else if (ready)
			message.innerHTML = `Waiting for ${game.owner_name} to start the game...`
		else
			message.innerHTML = "Waiting for players to join..."
	} else if (game.status === 1) {
		message.innerHTML = `<a href="/${game.title_id}/play.html?game=${game.game_id}">Observe</a>`
	} else if (game.status === 2) {
		message.innerHTML = `<a href="/${game.title_id}/play.html?game=${game.game_id}">Review</a>`
	} else {
		message.innerHTML = `<a href="/${game.title_id}/play.html?game=${game.game_id}">Enter</a>`
	}

	if (game.owner_id === user_id) {
		window.start_button.disabled = !ready
		window.start_button.classList = (game.status === 0) ? "" : "hide"
		window.delete_button.classList = (game.status === 0 || is_solo()) ? "" : "hide"
		if (game.status === 0 && ready)
			start_blinker("READY TO START")
		else
			stop_blinker()
	} else {
		if (start_status === 0 && game.status === 1)
			start_blinker("STARTED")
		else
			stop_blinker()
	}
}

window.onload = function () {
	update()
	if (game.status < 2) {
		start_event_source()
		timer = setInterval(start_event_source, 15000)
	}
}
