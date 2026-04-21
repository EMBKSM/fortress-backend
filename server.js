const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "https://euphonious-yeot-c27733.netlify.app", // 👈 Netlify 주소 입력 (끝에 /는 빼주세요)
        methods: ["GET", "POST"]
    }
});

const rooms = {};
let roomCounter = 0;

io.on('connection', (socket) => {
    console.log(`🟢 유저 접속: ${socket.id}`);
    const myNickname = `Player${Math.floor(Math.random() * 1000)}`;

    const emitRoomList = () => {
        const roomList = Object.keys(rooms).map(id => ({
            id, title: rooms[id].title, hasPassword: !!rooms[id].password,
            mapType: rooms[id].mapType, mapSize: rooms[id].mapSize,
            playerCount: rooms[id].players.length, maxPlayers: rooms[id].maxPlayers, status: rooms[id].status
        }));
        io.emit('roomList', roomList);
    };

    emitRoomList();

    // 1. 방 생성 (🔥 달러 기호 오타 수정 완료)
    socket.on('createRoom', ({ title, password, maxPlayers, mapType, mapSize }) => {
        roomCounter++;
        const roomId = `Room_${Math.random().toString(36).substr(2, 5)}_${roomCounter}`;
        
        rooms[roomId] = {
            id: roomId, 
            title: title || `Room ${roomCounter}`,
            password: password || null,
            maxPlayers: parseInt(maxPlayers) || (mapType === 1 ? 4 : 32),
            mapType, mapSize,
            players: [], turnIndex: 0, 
            mapSeed: Math.random() * 10000,
            wind: Math.floor(Math.random() * 21) - 10,
            status: 'waiting', timer: null
        };
        
        joinRoom(socket, roomId, myNickname, password);
        emitRoomList();
    });

    const joinRoom = (socket, roomId, nickname, password) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', '방이 존재하지 않습니다.');
        
        if (room.password && room.password !== password) {
            return socket.emit('error', '비밀번호가 틀렸습니다.');
        }
        
        if (room.players.length < room.maxPlayers && room.status === 'waiting') {
            socket.join(roomId);
            const playerIndex = room.players.length;
            room.players.push({ id: socket.id, index: playerIndex, nickname, hp: 1000 });

            socket.roomInfo = { roomId, playerIndex, nickname };

            socket.emit('playerAssigned', { playerIndex, roomId });
            io.to(roomId).emit('playerJoined', { count: room.players.length, maxPlayers: room.maxPlayers, players: room.players });
            emitRoomList();
        }
    };

    socket.on('joinRoom', ({ roomId, password }) => joinRoom(socket, roomId, myNickname, password));

    // 2. 턴 및 타이머 로직
    function nextTurn(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        let nextIdx = (room.turnIndex + 1) % room.players.length;
        let loopCount = 0;
        while (room.players[nextIdx].hp <= 0 && loopCount < room.players.length) {
            nextIdx = (nextIdx + 1) % room.players.length;
            loopCount++;
        }
        
        room.turnIndex = nextIdx;

        room.totalTurns = (room.totalTurns || 0) + 1;
        if (room.totalTurns % 3 === 0) {
            room.wind = Math.floor(Math.random() * 21) - 10;
        }

        io.to(roomId).emit('turnChanged', { 
            turnIndex: room.turnIndex,
            wind: room.wind
        });
        startTurnTimer(roomId);
    }

    function startTurnTimer(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        if (room.timer) clearInterval(room.timer);
        let timeLeft = 40;
        io.to(roomId).emit('turnTimer', { timeLeft });
        
        room.timer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('turnTimer', { timeLeft });
            if (timeLeft <= 0) nextTurn(roomId);
        }, 1000);
    }

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'waiting' && socket.roomInfo.playerIndex === 0) {
            room.status = 'playing';
            io.to(roomId).emit('gameStart', { 
                mapSeed: room.mapSeed,
                players: room.players.map(p => ({ id: p.id, index: p.index, nickname: p.nickname, hp: 1000 })),
                turnIndex: room.turnIndex,
                wind: room.wind
            });
            emitRoomList();
            startTurnTimer(roomId);
        }
    });

    socket.on('syncHp', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            data.hpUpdates.forEach(update => {
                if (room.players[update.index]) room.players[update.index].hp = update.hp;
            });
        }
    });

    socket.on('actionCompleted', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'playing') {
            if (room.timer) clearInterval(room.timer);
            setTimeout(() => nextTurn(roomId), 3000);
        }
    });

    socket.on('playerUpdate', (data) => socket.to(data.roomId).emit('opponentUpdate', data));
    socket.on('playerMove', (data) => socket.to(data.roomId).emit('opponentMove', data));
    socket.on('playerFire', (data) => socket.to(data.roomId).emit('opponentFire', data));

    // 🛡️ [추가] 플레이어 퇴장 통합 처리 함수 (좀비 방 방지)
    const handlePlayerLeave = (socket) => {
        if (!socket.roomInfo) return;
        const { roomId, playerIndex } = socket.roomInfo;
        const room = rooms[roomId];
        
        if (room) {
            if (room.status === 'waiting') {
                room.players = room.players.filter(p => p.id !== socket.id);
                // 🚀 남은 플레이어 인덱스를 0번부터 촘촘하게 재정렬!
                room.players.forEach((p, idx) => { p.index = idx; });
                if (room.players.length === 0) {
                    delete rooms[roomId]; // 아무도 없으면 방 파괴
                } else {
                    io.to(roomId).emit('playerJoined', { count: room.players.length, maxPlayers: room.maxPlayers, players: room.players });
                }
            } else if (room.status === 'playing') {
                const player = room.players.find(p => p.id === socket.id);
                if (player) {
                    player.hp = 0; // 자진 탈주 시 사망 처리
                    io.to(roomId).emit('playerDisconnected', { playerIndex });
                }
                // 방에 살아있는 사람이 0명이거나 아무도 소켓 연결이 안되어 있으면 방 폭파
                const aliveCount = room.players.filter(p => p.hp > 0).length;
                if (aliveCount <= 0) {
                    if (room.timer) clearInterval(room.timer);
                    delete rooms[roomId];
                }
            }
            emitRoomList();
        }
        socket.leave(roomId);
        socket.roomInfo = null;
    };

    // 사용자가 '방 나가기' 버튼을 눌렀을 때
    socket.on('leaveRoom', () => {
        handlePlayerLeave(socket);
    });

    // 브라우저를 강제로 껐을 때
    socket.on('disconnect', () => {
        console.log(`🔴 유저 접속 종료: ${socket.id}`);
        handlePlayerLeave(socket);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 포트리스 멀티플레이 서버 (포트 ${PORT}) 실행 중!`));
