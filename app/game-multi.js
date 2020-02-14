import Game from "./game.js";
import JsonRpc from "./json-rpc.js";
import * as html from "./html.js";
import * as score from "./score.js";
import Round from "./round.js";
const template = document.querySelector("template");
export default class MultiGame extends Game {
    constructor(board) {
        super(board);
        this._nodes = {};
        this._progress = {
            key: "",
            game: "",
            player: ""
        };
        this._wait = html.node("p", { className: "wait", hidden: true });
        ["setup", "lobby"].forEach(id => {
            let node = template.content.querySelector(`#multi-${id}`);
            this._nodes[id] = node.cloneNode(true);
        });
        const setup = this._nodes["setup"];
        setup.querySelector("[name=join]").addEventListener("click", _ => this._joinOrCreate());
        setup.querySelector("[name=continue]").addEventListener("click", _ => this._continue());
        setup.querySelector("[name=create-normal]").addEventListener("click", _ => this._joinOrCreate("normal"));
        setup.querySelector("[name=create-lake]").addEventListener("click", _ => this._joinOrCreate("lake"));
        const lobby = this._nodes["lobby"];
        lobby.querySelector("button").addEventListener("click", _ => this._rpc.call("start-game", []));
    }
    async play() {
        super.play();
        return new Promise(resolve => {
            this._resolve = resolve;
            this._setup();
        });
    }
    async _setup() {
        this._node.innerHTML = "";
        const setup = this._nodes["setup"];
        this._node.appendChild(setup);
        ["player", "game"].forEach(key => {
            let value = load(key);
            if (value === null) {
                return;
            }
            let input = setup.querySelector(`[name=${key}-name]`);
            input.value = value;
        });
        let cont = setup.querySelector(`[name=continue]`);
        cont.parentNode.hidden = (load("progress") === null);
        try {
            const url = new URL(location.href).searchParams.get("url") || "ws://localhost:1234";
            const ws = await openWebSocket(url);
            const rpc = createRpc(ws);
            ws.addEventListener("close", e => this._onClose(e));
            rpc.expose("game-change", () => this._sync());
            rpc.expose("game-destroy", () => {
                alert("The game has been cancelled");
                ws.close();
                this._resolve(false);
            });
            rpc.expose("game-over", (...scores) => {
                save("progress", null);
                this._outro();
                this._showScore(scores);
                ws.close();
                this._resolve(true);
            });
            let quit = html.node("button", {}, "Quit game");
            quit.addEventListener("click", async (_) => {
                if (!(confirm("Really quit the game?"))) {
                    return;
                }
                save("progress", null);
                await rpc.call("quit-game", []);
                ws.close();
                this._resolve(false);
            });
            this._bonusPool.node.appendChild(quit);
            this._rpc = rpc;
        }
        catch (e) {
            alert(e.message);
            this._resolve(false);
        }
    }
    _onClose(e) {
        if (e.code != 0 && e.code != 1000 && e.code != 1001) {
            alert("Network connection closed");
        }
        this._resolve(false);
    }
    async _joinOrCreate(type) {
        const setup = this._nodes["setup"];
        let playerName = setup.querySelector("[name=player-name]").value;
        if (!playerName) {
            return alert("Please provide your name");
        }
        let gameName = setup.querySelector("[name=game-name]").value;
        if (!gameName) {
            return alert("Please provide a game name");
        }
        save("player", playerName);
        save("game", gameName);
        const buttons = setup.querySelectorAll("button");
        buttons.forEach(b => b.disabled = true);
        let args = [gameName, playerName];
        if (type) {
            args.unshift(type);
        }
        try {
            const key = await this._rpc.call(type ? "create-game" : "join-game", args);
            this._progress.key = key;
            this._progress.player = playerName;
            this._progress.game = gameName;
            const lobby = this._nodes["lobby"];
            lobby.querySelector("button").disabled = (!type);
            this._node.innerHTML = "";
            this._node.appendChild(lobby);
        }
        catch (e) {
            alert(e.message);
        }
        finally {
            buttons.forEach(b => b.disabled = false);
        }
    }
    async _continue() {
        const saved = JSON.parse(load("progress") || "");
        try {
            this._progress.player = saved.player;
            this._progress.game = saved.game;
            this._progress.key = saved.key;
            await this._rpc.call("continue-game", [saved.game, saved.key]);
            this._board.fromJSON(saved.board);
            this._bonusPool.fromJSON(saved.bonusPool);
            this._sync();
        }
        catch (e) {
            save("progress", null);
            alert(e.message);
            this._resolve(false);
        }
    }
    async _sync() {
        const response = await this._rpc.call("game-info", []);
        switch (response.state) {
            case "starting":
                this._updateLobby(response.players);
                break;
            case "playing":
                this._updateRound(response);
                break;
        }
    }
    _updateLobby(players) {
        const lobby = this._nodes["lobby"];
        const list = lobby.querySelector("ul");
        list.innerHTML = "";
        players.forEach(p => {
            let item = html.node("li", {}, p.name);
            list.appendChild(item);
        });
        const button = lobby.querySelector("button");
        button.textContent = (button.disabled ? `Wait for ${players[0].name} to start the game` : "Start the game");
    }
    _updateRound(response) {
        let waiting = response.players.filter(p => !p.roundEnded).length;
        this._wait.textContent = `Waiting for ${waiting} player${waiting > 1 ? "s" : ""} to end round`;
        const ended = response.players.filter(p => p.name == this._progress.player)[0].roundEnded;
        this._wait.hidden = !ended;
        const round = this._progress.round;
        if (round && round.number == response.round) {
            ended && round.end();
        }
        else {
            this._newRound(response, ended);
        }
        this._saveProgress();
    }
    async _newRound(response, ended) {
        const round = new MultiplayerRound(response.round, this._board, this._bonusPool);
        this._progress.round = round;
        this._node.innerHTML = "";
        this._node.appendChild(this._bonusPool.node);
        this._node.appendChild(round.node);
        this._node.appendChild(this._wait);
        let promise = round.play(response.dice);
        if (ended) {
            round.end();
        }
        else {
            await promise;
            let s = this._board.getScore();
            let ns = score.toNetworkScore(s);
            this._rpc.call("end-round", ns);
        }
    }
    _showScore(scores) {
        let s = this._board.getScore();
        this._board.showScore(s);
        const placeholder = document.querySelector("#outro div");
        placeholder.innerHTML = "";
        placeholder.appendChild(score.renderMulti(scores));
    }
    _saveProgress() {
        const progress = {
            board: this._board,
            bonusPool: this._bonusPool,
            key: this._progress.key,
            game: this._progress.game,
            player: this._progress.player
        };
        save("progress", JSON.stringify(progress));
    }
}
class MultiplayerRound extends Round {
    _end() {
        super._end();
        this.end();
    }
    end() {
        this._endButton.disabled = true;
        this._pool.remaining.forEach(d => this._pool.disable(d));
    }
}
function createRpc(ws) {
    let io = {
        onData(_s) { },
        sendData(s) { ws.send(s); }
    };
    ws.addEventListener("message", e => io.onData(e.data));
    return new JsonRpc(io);
}
function openWebSocket(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
        ws.addEventListener("open", e => resolve(e.target));
        ws.addEventListener("error", _ => reject(new Error("Cannot connect to server")));
    });
}
function save(key, value) {
    key = `rri-${key}`;
    try {
        (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    }
    catch (e) {
        console.warn(e);
    }
}
function load(key) {
    try {
        return localStorage.getItem(`rri-${key}`);
    }
    catch (e) {
        console.warn(e);
        return null;
    }
}
