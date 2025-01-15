/****************************************************************************
 * server.js
 *
 * Usage:
 *   npm install express socket.io
 *   node server.js
 *
 * Key points:
 *   - On first connect, user sets a name.
 *   - They can rename at any time with "updateName".
 *   - The server retains their existing data based on the cookie "uid".
 ****************************************************************************/

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;

// Serve static files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// --- Load + Flatten Cards ---
const raw = fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8');
const expansions = JSON.parse(raw);
console.log(`Loaded expansions: ${expansions.length} total expansions.`);

let bigWhite = [];
let bigBlack = [];

expansions.forEach(pack => {
  if (Array.isArray(pack.white)) {
    bigWhite.push(...pack.white);
  }
  if (Array.isArray(pack.black)) {
    bigBlack.push(...pack.black);
  }
});

// Filter out multi-pick black cards
bigBlack = bigBlack.filter(card => (card.pick || 1) === 1);

let whiteDeck = bigWhite.map(o => o.text);
let blackDeck = bigBlack.map(o => ({ text: o.text, pick: 1 }));

console.log(`Flattened deck: ${whiteDeck.length} white cards, ${blackDeck.length} black cards.`);

// Shuffle helper
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
shuffle(whiteDeck);
shuffle(blackDeck);

// In-memory user data: uid -> { uid, name, socketId, score, hand, isHost, isSpectator }
let userData = {};
let hostUid = null;

let currentTzarUid = null;
let currentBlack = null;
let roundInProgress = false;
let playedCards = [];
let roundNumber = 0;

const HAND_SIZE = 10;

/*******************************************************************
 * Unique deck draws
 *******************************************************************/
function drawWhiteCard() {
  if (!whiteDeck.length) {
    console.warn('White deck exhausted!');
    return 'NO WHITE CARDS LEFT';
  }
  return whiteDeck.pop();
}
function drawBlackCard() {
  if (!blackDeck.length) {
    console.warn('Black deck exhausted!');
    return { text: 'NO MORE BLACK CARDS', pick: 1 };
  }
  return blackDeck.pop();
}

/*******************************************************************
 * Broadcasting / Player updates
 *******************************************************************/
function broadcastPlayers() {
  const arr = Object.values(userData).map(u => ({
    uid: u.uid,
    username: u.name,
    score: u.score,
    isHost: u.isHost,
    isSpectator: u.isSpectator,
    isTzar: (u.uid === currentTzarUid)
  }));
  io.emit('players', arr);
}

/*******************************************************************
 * Round logic
 *******************************************************************/
function startRound() {
  if (roundInProgress) return;
  roundInProgress = true;
  roundNumber++;
  playedCards = [];

  let activePlayers = Object.values(userData).filter(u => !u.isSpectator);
  if (!activePlayers.length) {
    console.log('No players to start round with.');
    return;
  }

  // Tzar rotation
  if (!currentTzarUid) {
    currentTzarUid = hostUid;
  } else {
    let idx = activePlayers.findIndex(x => x.uid === currentTzarUid);
    if (idx < 0) idx = 0;
    idx = (idx + 1) % activePlayers.length;
    currentTzarUid = activePlayers[idx].uid;
  }

  // Draw black
  currentBlack = drawBlackCard();

  io.emit('roundStarted', {
    roundNumber,
    tzarUid: currentTzarUid,
    blackCard: currentBlack.text
  });

  // Fill up hands
  activePlayers.forEach(u => {
    while (u.hand.length < HAND_SIZE) {
      u.hand.push(drawWhiteCard());
    }
    if (u.socketId) {
      io.to(u.socketId).emit('yourHand', u.hand);
    }
  });
}

function endRound(winnerUid) {
  roundInProgress = false;
  let winnerName = null;
  let winningCard = null;

  if (winnerUid && userData[winnerUid]) {
    userData[winnerUid].score++;
    winnerName = userData[winnerUid].name;
    let found = playedCards.find(pc => pc.uid === winnerUid);
    if (found) winningCard = found.cardText;
  }

  io.emit('roundEnded', {
    blackCard: currentBlack ? currentBlack.text : '',
    winnerUid,
    winnerName,
    winningCard
  });
  broadcastPlayers();

  // Next round, new arrivals won't be forced spectators
  Object.values(userData).forEach(u => {
    if (u.isSpectator) {
      u.isSpectator = false;
    }
  });
}

function playCard(uid, cardText) {
  if (!roundInProgress) return;
  if (uid === currentTzarUid) return; // tzar can't play
  const user = userData[uid];
  if (!user || user.isSpectator) return;

  let idx = user.hand.indexOf(cardText);
  if (idx < 0) return; // not in hand
  user.hand.splice(idx, 1);
  playedCards.push({ uid, cardText });

  // youAreReady
  if (user.socketId) {
    io.to(user.socketId).emit('youAreReady');
  }
  checkAllReady();
}

function checkAllReady() {
  let activeNonTzar = Object.values(userData).filter(u => !u.isSpectator && u.uid !== currentTzarUid);
  if (playedCards.length === activeNonTzar.length) {
    // All done => reveal to tzar
    io.emit('allCardsIn', {
      playedCards: playedCards.map(pc => ({
        cardText: pc.cardText,
        uid: pc.uid
      }))
    });
  } else {
    // Show who hasn't played yet
    let playedUids = playedCards.map(pc => pc.uid);
    let notPlayed = activeNonTzar.filter(x => !playedUids.includes(x.uid))
                                 .map(x => ({ uid: x.uid, username: x.name }));
    io.emit('notPlayedYet', notPlayed);
  }
}

/*******************************************************************
 * Re-sync user to current round if they reconnect or rename
 *******************************************************************/
function syncUserState(uid) {
  const user = userData[uid];
  if (!user || !user.socketId) return;
  if (!roundInProgress) return; // nothing to show if no round

  // Send them roundStarted
  io.to(user.socketId).emit('roundStarted', {
    roundNumber,
    tzarUid: currentTzarUid,
    blackCard: currentBlack ? currentBlack.text : '???'
  });

  const isTzar = (uid === currentTzarUid);
  let others = Object.values(userData).filter(u => !u.isSpectator && u.uid !== currentTzarUid);

  if (isTzar) {
    // Did everyone else play?
    if (playedCards.length === others.length) {
      // send allCardsIn
      io.to(user.socketId).emit('allCardsIn', {
        playedCards: playedCards.map(pc => ({
          cardText: pc.cardText,
          uid: pc.uid
        }))
      });
    } else {
      // Show who hasn't played yet
      let playedUids = playedCards.map(pc => pc.uid);
      let notPlayed = others.filter(x => !playedUids.includes(x.uid))
                            .map(x => ({ uid: x.uid, username: x.name }));
      if (notPlayed.length) {
        io.to(user.socketId).emit('notPlayedYet', notPlayed);
      }
    }
    return;
  }

  // If not tzar
  let alreadyPlayed = playedCards.find(pc => pc.uid === uid);
  if (alreadyPlayed) {
    // they already played
    io.to(user.socketId).emit('youAreReady');
  } else {
    // re-send their hand
    io.to(user.socketId).emit('yourHand', user.hand);
  }

  // who hasn't played
  let playedUids = playedCards.map(pc => pc.uid);
  let notPlayed = others.filter(x => !playedUids.includes(x.uid))
                        .map(x => ({ uid: x.uid, username: x.name }));
  if (notPlayed.length) {
    io.to(user.socketId).emit('notPlayedYet', notPlayed);
  }
}

/*******************************************************************
 * Socket logic
 *******************************************************************/
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('helloWithUid', (data) => {
    let { uid, desiredName } = data;
    if (!uid) return;

    // If brand new user
    if (!userData[uid]) {
      let finalName = desiredName || `Guest-${Math.random().toString(36).substr(2,4)}`;
      userData[uid] = {
        uid,
        name: finalName,
        socketId: socket.id,
        score: 0,
        hand: [],
        isHost: false,
        isSpectator: roundInProgress
      };
      console.log(`Created new user: ${uid} name=${finalName}`);
      // If no host => this user is host
      if (!hostUid) {
        hostUid = uid;
        userData[uid].isHost = true;
        console.log(`No host found, user ${uid} => host`);
      }
    } else {
      // returning user or rename
      userData[uid].socketId = socket.id;
      if (desiredName && desiredName !== userData[uid].name) {
        userData[uid].name = desiredName;
        console.log(`User ${uid} renamed to ${desiredName}`);
      }
    }
    broadcastPlayers();
    syncUserState(uid);
  });

  // Let user rename mid-game
  socket.on('updateName', (newName) => {
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    if (newName) {
      userData[uid].name = newName;
      console.log(`User ${uid} changed name to ${newName}`);
      broadcastPlayers();
      // Also re-sync them in case we need updated name in notPlayedYet
      syncUserState(uid);
    }
  });

  socket.on('startRound', () => {
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    if (uid !== hostUid) return;
    if (!roundInProgress) startRound();
  });

  socket.on('playCard', (cardText) => {
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    playCard(uid, cardText);
  });

  socket.on('pickWinner', (winnerUid) => {
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    if (uid !== currentTzarUid) return;
    endRound(winnerUid);
  });

  socket.on('leaveGame', () => {
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    delete userData[uid];
    if (uid === hostUid) {
      let keys = Object.keys(userData);
      hostUid = keys.length ? keys[0] : null;
      if (hostUid) userData[hostUid].isHost = true;
    }
    broadcastPlayers();
  });

  socket.on('disconnect', () => {
    console.log(`Socket ${socket.id} disconnected`);
    let uid = findUidBySocket(socket.id);
    if (!uid) return;
    // Keep them in userData but remove socketId
    userData[uid].socketId = null;
    // If tzar left mid-round => endRound with no winner
    if (uid === currentTzarUid && roundInProgress) {
      console.log('Tzar disconnected, round ended no winner');
      endRound(null);
    }
  });
});

function findUidBySocket(sockId) {
  let arr = Object.values(userData);
  let found = arr.find(u => u.socketId === sockId);
  return found ? found.uid : null;
}

// Show local IPs
function getLocalIPs() {
  let ifaces = os.networkInterfaces();
  let results = [];
  for (let dev in ifaces) {
    ifaces[dev].forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push(addr.address);
      }
    });
  }
  return results;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const ips = getLocalIPs();
  ips.forEach(ip => {
    console.log(`   http://${ip}:${PORT}`);
  });
});
