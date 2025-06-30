const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Fix memory leak warning
server.setMaxListeners(50);
process.setMaxListeners(50);

// Serve static files from current directory
app.use(express.static(__dirname));

// Game state management
const rooms = new Map();
const playerSockets = new Map(); // Track socket to room mapping

// Configuration
const MAX_ROOMS = 100;
const ROOM_CLEANUP_INTERVAL = 2 * 60 * 1000; // 2 minutes
const PLAYER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Card definitions
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const ranks = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Team-based seating arrangement
const TEAM_POSITIONS = {
    'A': [0, 2], // Top and Bottom
    'B': [1, 3]  // Right and Left
};

// Room statistics
function getRoomStats() {
    const stats = {
        totalRooms: rooms.size,
        activeRooms: 0,
        waitingRooms: 0,
        playingRooms: 0,
        pausedRooms: 0,
        totalPlayers: 0,
        connectedPlayers: 0
    };
    
    for (const [roomId, room] of rooms) {
        const connectedCount = room.players.filter(p => p && p.connected).length;
        stats.totalPlayers += room.players.filter(p => p !== null).length;
        stats.connectedPlayers += connectedCount;
        
        if (connectedCount > 0) stats.activeRooms++;
        
        switch (room.gameState) {
            case 'waiting': stats.waitingRooms++; break;
            case 'playing': 
            case 'trump_selection': stats.playingRooms++; break;
            case 'paused': stats.pausedRooms++; break;
        }
    }
    
    return stats;
}

// Enhanced logging with room context
function logWithRoom(roomId, message, ...args) {
    console.log(`[Room:${roomId}] ${message}`, ...args);
}

// Create a deck of cards
function createDeck() {
    const deck = [];
    suits.forEach(suit => {
        ranks.forEach(rank => {
            deck.push({ suit, rank });
        });
    });
    return deck;
}

// Shuffle deck
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Get card value for comparison
function getCardValue(card, trump) {
    const rankValues = { '7': 1, '8': 2, '9': 3, '10': 4, 'J': 5, 'Q': 6, 'K': 7, 'A': 8 };
    let value = rankValues[card.rank];
    
    // Trump cards are worth more
    if (card.suit === trump) {
        value += 10;
    }
    
    return value;
}

// Check if a card can be played
function isValidPlay(card, hand, currentTrick, trump) {
    console.log('Validating card play:', {
        card: `${card.rank} of ${card.suit}`,
        hand: hand.filter(c => c).map(c => `${c.rank} of ${c.suit}`),
        currentTrick: currentTrick.map(t => `${t.card.rank} of ${t.card.suit}`),
        trump,
        trickLength: currentTrick.length
    });

    // First card of trick - any card is valid (leading)
    if (currentTrick.length === 0) {
        console.log('First card of trick (leading) - any card valid');
        return true;
    }

    // Get the lead suit (first card played in this trick)
    const leadSuit = currentTrick[0].card.suit;
    console.log('Lead suit:', leadSuit);

    // Check if player has any cards of the lead suit
    const cardsOfLeadSuit = hand.filter(c => c && c.suit === leadSuit);
    console.log('Cards of lead suit available:', cardsOfLeadSuit.map(c => `${c.rank} of ${c.suit}`));

    if (cardsOfLeadSuit.length > 0) {
        // Player HAS cards of the lead suit - MUST follow suit
        const mustFollowSuit = card.suit === leadSuit;
        console.log('MUST follow suit - has lead suit cards. Playing:', card.suit, 'Required:', leadSuit, 'Valid:', mustFollowSuit);
        return mustFollowSuit;
    } else {
        // Player does NOT have cards of the lead suit - can play ANY card
        console.log('NO lead suit cards - can play ANY card (including trump to cut)');
        return true;
    }
}

// Get playable cards for a player (for client-side UI)
function getPlayableCards(hand, currentTrick, trump) {
    const playableCards = [];

    console.log('=== GETTING PLAYABLE CARDS ===');
    console.log('Hand:', hand.map((c, i) => c ? `${i}: ${c.rank}${c.suit[0]}` : `${i}: null`));
    console.log('Current trick:', currentTrick.map(t => `${t.card.rank}${t.card.suit[0]}`));
    console.log('Trump:', trump);

    // If leading (first card), all non-null cards are playable
    if (currentTrick.length === 0) {
        console.log('Leading - checking all non-null cards');
        hand.forEach((card, index) => {
            if (card !== null) {
                playableCards.push(index);
                console.log(`Card ${index} (${card.rank}${card.suit[0]}) is playable - leading`);
            }
        });
        console.log('Leading playable cards:', playableCards);
        return playableCards;
    }

    // Get the lead suit (first card played in this trick)
    const leadSuit = currentTrick[0].card.suit;
    console.log('Lead suit:', leadSuit);

    // Find all cards of the lead suit in hand
    const leadSuitCardIndices = [];
    hand.forEach((card, index) => {
        if (card && card.suit === leadSuit) {
            leadSuitCardIndices.push(index);
        }
    });

    console.log('Lead suit card indices:', leadSuitCardIndices);

    if (leadSuitCardIndices.length > 0) {
        // Player HAS cards of the lead suit - MUST play only those
        console.log('Player has lead suit cards - MUST follow suit');
        leadSuitCardIndices.forEach(index => {
            playableCards.push(index);
            console.log(`Card ${index} (${hand[index].rank}${hand[index].suit[0]}) is playable - following suit`);
        });
    } else {
        // Player does NOT have cards of the lead suit - can play ANY remaining card
        console.log('Player has NO lead suit cards - can play any card');
        hand.forEach((card, index) => {
            if (card !== null) {
                playableCards.push(index);
                console.log(`Card ${index} (${card.rank}${card.suit[0]}) is playable - no lead suit`);
            }
        });
    }

    console.log('Final playable cards:', playableCards);
    console.log('=== END PLAYABLE CARDS ===');

    return playableCards;
}

// Determine trick winner
function getTrickWinner(trick, trump) {
    console.log('Determining trick winner:', {
        trick: trick.map(t => `${t.playerName}: ${t.card.rank} of ${t.card.suit}`),
        trump
    });

    const leadSuit = trick[0].card.suit;
    
    // Separate trump cards and non-trump cards
    const trumpCards = trick.filter(t => t.card.suit === trump);
    const nonTrumpCards = trick.filter(t => t.card.suit !== trump);
    
    console.log('Trump cards in trick:', trumpCards.map(t => `${t.playerName}: ${t.card.rank} of ${t.card.suit}`));
    console.log('Non-trump cards in trick:', nonTrumpCards.map(t => `${t.playerName}: ${t.card.rank} of ${t.card.suit}`));
    
    let winner;
    
    if (trumpCards.length > 0) {
        // If there are trump cards, highest trump wins
        winner = trumpCards.reduce((highest, current) => {
            return getCardValue(current.card, trump) > getCardValue(highest.card, trump) ? current : highest;
        });
        console.log('Trump card wins:', `${winner.playerName} with ${winner.card.rank} of ${winner.card.suit}`);
    } else {
        // No trump cards, highest card of lead suit wins
        const leadSuitCards = trick.filter(t => t.card.suit === leadSuit);
        winner = leadSuitCards.reduce((highest, current) => {
            return getCardValue(current.card, trump) > getCardValue(highest.card, trump) ? current : highest;
        });
        console.log('Lead suit wins:', `${winner.playerName} with ${winner.card.rank} of ${winner.card.suit}`);
    }
    
    return winner;
}

// Get team for position
function getTeamForPosition(position) {
    return TEAM_POSITIONS.A.includes(position) ? 'A' : 'B';
}

// Find available position for team
function findPositionForTeam(room, preferredTeam) {
    const availablePositions = TEAM_POSITIONS[preferredTeam].filter(pos => 
        !room.players[pos] || !room.players[pos].id
    );
    
    if (availablePositions.length > 0) {
        return availablePositions[0];
    }
    
    // If preferred team is full, try other team
    const otherTeam = preferredTeam === 'A' ? 'B' : 'A';
    const otherAvailablePositions = TEAM_POSITIONS[otherTeam].filter(pos => 
        !room.players[pos] || !room.players[pos].id
    );
    
    if (otherAvailablePositions.length > 0) {
        return otherAvailablePositions[0];
    }
    
    return -1; // Room is full
}

// Initialize room
function initializeRoom(roomId) {
    logWithRoom(roomId, 'Initializing new room');
    return {
        id: roomId,
        players: [null, null, null, null], // 4 positions with team-based seating
        gameState: 'waiting', // waiting, trump_selection, playing, completed, paused
        deck: [],
        trump: null,
        trumpSelector: -1, // Track who selected trump for scoring
        currentPlayerIndex: 0,
        currentTrick: [],
        tricksWon: [0, 0, 0, 0], // tricks won by each player
        scores: { teamA: 0, teamB: 0 }, // Team A: players 0,2; Team B: players 1,3
        round: 1,
        currentRoundIndex: 0, // Always 8 cards per player in Omi (single round game)
        lastTrickWinner: -1,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
}

// Enhanced room cleanup
function cleanupRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    logWithRoom(roomId, 'Cleaning up room');
    
    // Notify any remaining connected players
    room.players.forEach(player => {
        if (player && player.connected) {
            io.to(player.id).emit('roomClosed', {
                message: 'Room has been closed due to inactivity'
            });
            // Remove from player tracking
            playerSockets.delete(player.id);
        }
    });
    
    rooms.delete(roomId);
}

// Check room health and cleanup if needed
function checkRoomHealth(roomId) {
    const room = rooms.get(roomId);
    if (!room) return false;
    
    const now = Date.now();
    const connectedPlayers = room.players.filter(p => p && p.connected);
    
    // Room is empty - mark for cleanup
    if (connectedPlayers.length === 0) {
        if (now - room.lastActivity > 2 * 60 * 1000) { // 2 minutes
            cleanupRoom(roomId);
            return false;
        }
    }
    
    // Room has inactive players - clean them up
    let hasChanges = false;
    room.players.forEach((player, index) => {
        if (player && !player.connected && 
            now - player.lastSeen > PLAYER_TIMEOUT) {
            logWithRoom(roomId, `Removing inactive player ${player.name}`);
            room.players[index] = null;
            hasChanges = true;
        }
    });
    
    if (hasChanges) {
        room.lastActivity = now;
        // Notify remaining players
        const remainingPlayers = room.players.filter(p => p && p.connected);
        if (remainingPlayers.length > 0) {
            const playerList = room.players.map((p, index) => p ? { 
                name: p.name, 
                team: p.team,
                position: index,
                connected: p.connected
            } : null);
            
            remainingPlayers.forEach(player => {
                io.to(player.id).emit('roomCleaned', {
                    players: playerList,
                    connectedCount: remainingPlayers.length
                });
            });
        }
    }
    
    return true;
}

// Get current game state for reconnection
function getFullGameStateForPlayer(room, playerPosition) {
    const player = room.players[playerPosition];
    if (!player) return null;
    
    return {
        // Basic game info
        gameState: room.gameState,
        trump: room.trump,
        currentPlayerIndex: room.currentPlayerIndex,
        
        // Player's personal info
        position: playerPosition,
        hand: player.hand || [],
        
        // Turn info
        isYourTurn: room.currentPlayerIndex === playerPosition && room.gameState === 'playing',
        playableCards: room.currentPlayerIndex === playerPosition && room.gameState === 'playing' ? 
            getPlayableCards(player.hand || [], room.currentTrick, room.trump) : [],
        
        // Current trick
        currentTrick: room.currentTrick || [],
        
        // Scores and stats
        scores: room.scores,
        tricksWon: room.tricksWon,
        
        // Player names
        playerNames: room.players.map(p => p ? p.name : null),
        
        // All players info (for UI updates)
        players: room.players.map((p, index) => p ? {
            name: p.name,
            team: p.team,
            position: index,
            connected: p.connected
        } : null)
    };
}

// Add player to room with team selection
function addPlayerToRoom(roomId, playerData, preferredTeam, isReconnect = false) {
    // Check room limits
    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
        return { success: false, message: 'Server is full. Please try again later.' };
    }
    
    if (!rooms.has(roomId)) {
        rooms.set(roomId, initializeRoom(roomId));
    }
    
    const room = rooms.get(roomId);
    room.lastActivity = Date.now();
    
    // If reconnecting, try to find existing player slot
    if (isReconnect) {
        logWithRoom(roomId, `Looking for existing disconnected player named "${playerData.name}"`);
        console.log('Current players:', room.players.map((p, i) => p ? `${i}: ${p.name} (${p.connected ? 'connected' : 'disconnected'})` : `${i}: empty`));
        
        const existingPlayerIndex = room.players.findIndex(p => 
            p && p.name === playerData.name && !p.connected
        );
        
        if (existingPlayerIndex !== -1) {
            // Reconnect to existing slot
            logWithRoom(roomId, `Found disconnected player "${playerData.name}" at position ${existingPlayerIndex}`);
            room.players[existingPlayerIndex].id = playerData.id;
            room.players[existingPlayerIndex].connected = true;
            room.players[existingPlayerIndex].lastSeen = Date.now();
            
            // Update player tracking
            playerSockets.set(playerData.id, roomId);
            
            console.log(`Player ${playerData.name} reconnected to position ${existingPlayerIndex}`);
            
            return { 
                success: true, 
                room, 
                position: existingPlayerIndex,
                isReconnection: true 
            };
        } else {
            console.log(`No disconnected player found with name "${playerData.name}"`);
            // If trying to reconnect but no slot found, check if name is already connected
            const connectedPlayerIndex = room.players.findIndex(p => 
                p && p.name === playerData.name && p.connected
            );
            
            if (connectedPlayerIndex !== -1) {
                console.log(`Player "${playerData.name}" is already connected at position ${connectedPlayerIndex}`);
                return { success: false, message: 'Player with this name is already connected' };
            }
            
            console.log(`No existing player found with name "${playerData.name}", falling back to normal join`);
            // Fall through to normal join process
        }
    }
    
    // Find position for preferred team
    const position = findPositionForTeam(room, preferredTeam);
    
    if (position === -1) {
        return { success: false, message: 'Room is full' };
    }
    
    // Check if name is already taken by connected player
    const existingPlayers = room.players.filter(p => p !== null && p.connected);
    if (existingPlayers.some(p => p.name === playerData.name)) {
        return { success: false, message: 'Name already taken' };
    }
    
    room.players[position] = {
        id: playerData.id,
        name: playerData.name,
        team: getTeamForPosition(position),
        hand: [],
        connected: true,
        position: position,
        lastSeen: Date.now()
    };
    
    // Update player tracking
    playerSockets.set(playerData.id, roomId);
    
    logWithRoom(roomId, `Player ${playerData.name} joined at position ${position} (Team ${getTeamForPosition(position)})`);
    
    return { success: true, room, position, isReconnection: false };
}

// Start game
function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return false;
    
    const connectedPlayers = room.players.filter(p => p !== null);
    if (connectedPlayers.length !== 4) return false;
    
    logWithRoom(roomId, 'Starting game');
    
    room.gameState = 'trump_selection';
    room.currentRoundIndex = 0;
    room.currentPlayerIndex = 0; // First player selects trump
    room.trumpSelector = 0; // Track who selects trump
    room.scores = { teamA: 0, teamB: 0 };
    room.tricksWon = [0, 0, 0, 0];
    room.lastActivity = Date.now();
    
    // Deal initial cards for trump selection (4 cards each)
    dealCardsForTrumpSelection(room);
    
    return true;
}

// Deal cards for trump selection
function dealCardsForTrumpSelection(room) {
    const deck = shuffleDeck(createDeck());
    room.deck = deck;
    
    // Only deal 4 cards to the trump selector (current player)
    const trumpSelector = room.players[room.currentPlayerIndex];
    if (trumpSelector) {
        trumpSelector.hand = deck.splice(0, 4);
        
        // Clear other players' hands
        room.players.forEach((player, index) => {
            if (player && index !== room.currentPlayerIndex) {
                player.hand = [];
            }
        });
        
        logWithRoom(room.id, `Dealt 4 cards to trump selector ${trumpSelector.name} for trump selection`);
    }
}

// Deal remaining cards after trump selection
function dealRemainingCards(room) {
    logWithRoom(room.id, 'Dealing 8 cards to all players after trump selection');
    
    // Deal 8 cards to each player
    room.players.forEach((player, index) => {
        if (!player) return;
        
        if (index === room.currentPlayerIndex) {
            // Trump selector already has 4 cards, give them 4 more
            const currentCards = player.hand.filter(card => card !== null).length;
            console.log(`${player.name} (trump selector): currently has ${currentCards} cards`);
            
            const newCards = room.deck.splice(0, 4);
            player.hand.push(...newCards);
            console.log(`Dealt 4 additional cards to ${player.name}. Total: ${player.hand.length}`);
        } else {
            // Other players get full 8 cards
            player.hand = room.deck.splice(0, 8);
            console.log(`Dealt 8 cards to ${player.name}. Total: ${player.hand.length}`);
        }
    });
    
    console.log(`Deck cards remaining: ${room.deck.length}`);
}

// Check if game round is complete and handle scoring
function checkRoundComplete(room) {
    // In Omi, each player gets 8 cards, so there are exactly 8 tricks per game
    const tricksExpected = 8;
    const tricksPlayed = room.tricksWon.reduce((a, b) => a + b, 0);
    
    console.log(`Game check: ${tricksPlayed}/${tricksExpected} tricks played`);
    
    if (tricksPlayed >= tricksExpected) {
        // Game complete - calculate team scores
        const teamATricks = room.tricksWon[0] + room.tricksWon[2];
        const teamBTricks = room.tricksWon[1] + room.tricksWon[3];
        
        console.log(`Game complete. Team A: ${teamATricks} tricks, Team B: ${teamBTricks} tricks`);
        console.log(`Trump was selected by player ${room.trumpSelector}`);
        
        // Determine trump team and defending team
        const trumpTeam = getTeamForPosition(room.trumpSelector);
        const defendingTeam = trumpTeam === 'A' ? 'B' : 'A';
        
        console.log(`Trump team: Team ${trumpTeam}, Defending team: Team ${defendingTeam}`);
        
        // Scoring logic (authentic Omi rules)
        let pointsAwarded = 0;
        let winningTeam = null;
        
        if (teamATricks > teamBTricks) {
            // Team A won more tricks
            winningTeam = 'A';
            if (defendingTeam === 'A' && teamATricks === tricksExpected) {
                // Defending team swept all tricks - 2 points
                pointsAwarded = 2;
                console.log('Defending team (A) swept all tricks - 2 points!');
            } else {
                // Normal win - 1 point
                pointsAwarded = 1;
                console.log('Team A won majority - 1 point');
            }
            room.scores.teamA += pointsAwarded;
        } else if (teamBTricks > teamATricks) {
            // Team B won more tricks
            winningTeam = 'B';
            if (defendingTeam === 'B' && teamBTricks === tricksExpected) {
                // Defending team swept all tricks - 2 points
                pointsAwarded = 2;
                console.log('Defending team (B) swept all tricks - 2 points!');
            } else {
                // Normal win - 1 point
                pointsAwarded = 1;
                console.log('Team B won majority - 1 point');
            }
            room.scores.teamB += pointsAwarded;
        }
        // Tie = no points awarded
        
        console.log(`Final scores after game: Team A: ${room.scores.teamA}, Team B: ${room.scores.teamB}`);
        
        // Check if someone has won the match (typically first to 10 tokens in Omi)
        const targetScore = 10;
        if (room.scores.teamA >= targetScore || room.scores.teamB >= targetScore) {
            room.gameState = 'completed';
            return { 
                roundComplete: true, 
                gameComplete: true, 
                roundResult: {
                    winningTeam,
                    pointsAwarded,
                    teamATricks,
                    teamBTricks,
                    trumpTeam,
                    defendingTeam
                }
            };
        } else {
            // Start next game (new deal, new trump selection)
            room.tricksWon = [0, 0, 0, 0];
            room.currentTrick = [];
            room.trump = null;
            room.gameState = 'trump_selection';
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 4; // Next player selects trump
            room.trumpSelector = room.currentPlayerIndex; // Update trump selector
            return { 
                roundComplete: true, 
                gameComplete: false,
                roundResult: {
                    winningTeam,
                    pointsAwarded,
                    teamATricks,
                    teamBTricks,
                    trumpTeam,
                    defendingTeam
                }
            };
        }
    }
    
    return { roundComplete: false, gameComplete: false };
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinRoom', ({ room: roomId, name, team, isReconnect }) => {
        logWithRoom(roomId, `${name} attempting to ${isReconnect ? 'reconnect to' : 'join'} for team ${team}`);

        // Try to add (or re-add) the player
        const result = addPlayerToRoom(roomId, { id: socket.id, name }, team, isReconnect);
        if (!result.success) {
            socket.emit('error', { message: result.message });
            return;
        }

        const room = result.room;
        const position = result.position;
        
        // Store room info on socket for cleanup
        socket.roomId = roomId;
        socket.playerName = name;
        socket.join(roomId);

        // --- RECONNECTION BRANCH ---
        if (result.isReconnection) {
            console.log(`${name} reconnected to position ${position}`);

            // Get comprehensive game state for this player
            const gameState = getFullGameStateForPlayer(room, position);
            
            if (gameState) {
                // Send complete game state to reconnected player
                console.log(`Sending full game state to reconnected player ${name}`);
                console.log('Game state being sent:', {
                    gameState: gameState.gameState,
                    trump: gameState.trump,
                    handSize: gameState.hand.length,
                    isYourTurn: gameState.isYourTurn,
                    playableCards: gameState.playableCards,
                    currentTrick: gameState.currentTrick.length
                });
                
                socket.emit('gameInProgress', gameState);
            }

            // Notify other players of reconnection
            socket.to(roomId).emit('playerRejoined', { 
                name, 
                position,
                gameState: room.gameState 
            });

            // Resume game if it was paused
            const connectedPlayers = room.players.filter(p => p && p.connected).length;
            if (room.gameState === 'paused' && connectedPlayers >= 4) {
                console.log(`All players reconnected. Resuming game. Previous state: ${room.gameState}`);
                
                // Check if we were in trump selection or playing
                if (room.trump === null) {
                    // We were in trump selection phase
                    room.gameState = 'trump_selection';
                    console.log('Resuming trump selection phase');
                    
                    // Send trump selection to the trump selector
                    const trumpSelector = room.players[room.currentPlayerIndex];
                    if (trumpSelector && trumpSelector.connected) {
                        console.log(`Sending trump selection to ${trumpSelector.name}`);
                        
                        // Make sure trump selector has cards
                        if (!trumpSelector.hand || trumpSelector.hand.length === 0) {
                            console.log('Trump selector has no cards, dealing new cards');
                            dealCardsForTrumpSelection(room);
                        }
                        
                        io.to(trumpSelector.id).emit('canSelectTrump', {
                            hand: trumpSelector.hand,
                            message: `Game resumed - Select trump suit from your 4 cards`
                        });
                        
                        // Notify others to wait
                        room.players.forEach((player, index) => {
                            if (player && player.connected && index !== room.currentPlayerIndex) {
                                io.to(player.id).emit('waitingForTrump', {
                                    message: `Game resumed - Waiting for ${trumpSelector.name} to select trump`,
                                    trumpSelector: trumpSelector.name
                                });
                            }
                        });
                    }
                } else {
                    // We were in playing phase
                    room.gameState = 'playing';
                    console.log('Resuming playing phase');
                    
                    io.to(roomId).emit('gameResumed', { 
                        message: `${name} reconnected. Game resumed!` 
                    });
                    
                    // If it's the reconnected player's turn, send turn notification
                    if (room.currentPlayerIndex === position) {
                        const playableCards = getPlayableCards(
                            room.players[position].hand, 
                            room.currentTrick, 
                            room.trump
                        );
                        
                        socket.emit('yourTurn', {
                            message: 'Your turn! (Game resumed)',
                            playableCards: playableCards
                        });
                    }
                }
            }
            
            return;
        }

        // --- NEW JOIN BRANCH (your existing logic) ---
        const playerList = room.players.map((p, i) => p ? {
            name: p.name, team: p.team, position: i, connected: p.connected
        } : null);

        io.to(roomId).emit('playerJoined', {
            name,
            playerCount: room.players.filter(p => p && p.connected).length,
            players: playerList
        });

        // If you have exactly 4 players, kick off your startGame/deal/trump flow:
        if (room.players.filter(p => p && p.connected).length === 4 && room.gameState === 'waiting') {
            if (startGame(roomId)) {
                // Send trump selection cards to the trump selector
                const trumpSelector = room.players[room.currentPlayerIndex];
                if (trumpSelector && trumpSelector.connected) {
                    io.to(trumpSelector.id).emit('canSelectTrump', {
                        hand: trumpSelector.hand,
                        message: `Select trump suit from your 4 cards`
                    });
                    
                    // Notify others to wait
                    room.players.forEach((player, index) => {
                        if (player && player.connected && index !== room.currentPlayerIndex) {
                            io.to(player.id).emit('waitingForTrump', {
                                message: `Waiting for ${trumpSelector.name} to select trump`,
                                trumpSelector: trumpSelector.name
                            });
                        }
                    });
                }
            }
        }
    });

    // Explicit rejoin alias
    socket.on('rejoinRoom', ({ room: roomId, name, team }) => {
        console.log(`${name} explicitly trying to rejoin room ${roomId}`);
        socket.emit('joinRoom', { room: roomId, name, team, isReconnect: true });
    });

    socket.on('selectTrump', ({ room: roomId, trump }) => {
        const room = rooms.get(roomId);
        if (!room || room.gameState !== 'trump_selection') {
            socket.emit('error', { message: 'Cannot select trump now' });
            return;
        }
        
        const playerIndex = room.players.findIndex(p => p && p.id === socket.id);
        if (playerIndex !== room.currentPlayerIndex) {
            socket.emit('error', { message: 'Not your turn to select trump' });
            return;
        }
        
        logWithRoom(roomId, `${socket.playerName} selected ${trump} as trump`);
        
        room.trump = trump;
        room.trumpSelector = playerIndex; // Record who selected trump
        room.gameState = 'playing';
        room.lastActivity = Date.now();
        
        // Notify all players of trump selection
        io.to(roomId).emit('trumpSelected', {
            by: socket.playerName,
            trump,
            message: `${socket.playerName} selected ${trump} as trump`
        });
        
        // Deal remaining cards
        dealRemainingCards(room);
        
        // Send full hands to all players and start first trick
        room.players.forEach((player, index) => {
            if (!player) return;
            
            io.to(player.id).emit('fullHand', {
                hand: player.hand,
                position: index,
                isYourTurn: false, // Initially false for all
                trump: room.trump
            });
        });
        
        // Set the trump selector as the first to play
        const currentPlayer = room.players[room.currentPlayerIndex];
        if (currentPlayer) {
            const playableCards = getPlayableCards(currentPlayer.hand, room.currentTrick, room.trump);
            
            console.log(`${currentPlayer.name} to play first. Playable cards:`, playableCards);
            
            io.to(currentPlayer.id).emit('yourTurn', {
                message: 'Your turn! You lead the first trick.',
                playableCards: playableCards
            });
            
            // Notify others about whose turn it is
            room.players.forEach((player, index) => {
                if (player && index !== room.currentPlayerIndex) {
                    io.to(player.id).emit('turnUpdate', {
                        currentPlayer: currentPlayer.name,
                        currentPlayerIndex: room.currentPlayerIndex
                    });
                }
            });
        }
    });
    
    socket.on('playCard', ({ room: roomId, cardIndex }) => {
        const room = rooms.get(roomId);
        if (!room || room.gameState !== 'playing') {
            socket.emit('error', { message: 'Game not in playing state' });
            return;
        }
        
        const playerIndex = room.players.findIndex(p => p && p.id === socket.id);
        if (playerIndex === -1) {
            socket.emit('error', { message: 'Player not found' });
            return;
        }
        
        if (playerIndex !== room.currentPlayerIndex) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }
        
        const player = room.players[playerIndex];
        const card = player.hand[cardIndex];
        
        if (!card) {
            socket.emit('error', { message: 'Invalid card - card not found' });
            return;
        }
        
        // Validate card play
        if (!isValidPlay(card, player.hand, room.currentTrick, room.trump)) {
            console.log('Invalid play detected for:', `${card.rank} of ${card.suit}`);
            
            // Provide helpful error message
            const leadSuit = room.currentTrick.length > 0 ? room.currentTrick[0].card.suit : null;
            const hasLeadSuit = leadSuit ? player.hand.some(c => c && c.suit === leadSuit) : false;
            
            let errorMessage = 'Invalid card!';
            if (leadSuit && hasLeadSuit) {
                errorMessage = `Must follow suit! You have ${leadSuit} cards.`;
            }
            
            socket.emit('error', { message: errorMessage });
            return;
        }
        
        room.lastActivity = Date.now();
        console.log(`${player.name} played ${card.rank} of ${card.suit}`);
        
        // Add card to current trick
        room.currentTrick.push({
            playerIndex,
            playerName: player.name,
            card
        });
        
        // Remove card from player's hand
        player.hand[cardIndex] = null;
        
        // Notify all players
        const trickProgress = `${room.currentTrick.length}/4 cards played`;
        io.to(roomId).emit('cardPlayed', {
            player: player.name,
            playerIndex,
            card,
            trickProgress
        });
        
        // Check if trick is complete (4 cards played)
        if (room.currentTrick.length === 4) {
            // Determine winner
            const winner = getTrickWinner(room.currentTrick, room.trump);
            const winnerIndex = winner.playerIndex;
            
            console.log(`Trick won by ${winner.playerName} (player ${winnerIndex})`);
            
            // Update tricks won
            room.tricksWon[winnerIndex]++;
            
            // Store trick cards for "last trick" display
            const trickCards = room.currentTrick.map(t => t.card);
            
            // Clear current trick
            room.currentTrick = []; // ✅ This is critical - clear the trick
            
            // Set winner as next to play
            room.currentPlayerIndex = winnerIndex;
            room.lastTrickWinner = winnerIndex;
            
            // Notify all players of trick result
            io.to(roomId).emit('trickComplete', {
                winner: winner.playerName,
                winnerIndex,
                trickCards,
                scores: room.scores,
                tricksWon: room.tricksWon
            });
            
            // Check if round/game is complete
            const roundStatus = checkRoundComplete(room);
            
            if (roundStatus.gameComplete) {
                // Game over
                const finalWinner = room.scores.teamA > room.scores.teamB ? 'Team A' : 
                                   room.scores.teamB > room.scores.teamA ? 'Team B' : 'Tie';
                
                io.to(roomId).emit('gameOver', {
                    winner: finalWinner,
                    finalScores: room.scores,
                    roundResult: roundStatus.roundResult,
                    message: `Game complete! ${finalWinner} wins with ${Math.max(room.scores.teamA, room.scores.teamB)} points!`
                });
                
                // Clean up room after delay
                setTimeout(() => cleanupRoom(roomId), 30000); // 30 second delay
                
            } else if (roundStatus.roundComplete) {
                // Round complete - show round results
                io.to(roomId).emit('roundComplete', {
                    roundResult: roundStatus.roundResult,
                    newScores: room.scores,
                    message: `Round complete! Team ${roundStatus.roundResult.winningTeam} scored ${roundStatus.roundResult.pointsAwarded} point(s)`
                });
                
                // Start next game
                setTimeout(() => {
                    dealCardsForTrumpSelection(room);
                    
                    const trumpSelector = room.players[room.currentPlayerIndex];
                    if (trumpSelector && trumpSelector.connected) {
                        io.to(trumpSelector.id).emit('canSelectTrump', {
                            hand: trumpSelector.hand,
                            message: `New game - Select trump suit`
                        });
                        
                        room.players.forEach((player, index) => {
                            if (player && player.connected && index !== room.currentPlayerIndex) {
                                io.to(player.id).emit('waitingForTrump', {
                                    message: `New game - Waiting for trump selection`,
                                    trumpSelector: trumpSelector.name
                                });
                            }
                        });
                    }
                }, 3000);
                
            } else {
                // Continue with next trick - winner leads
                setTimeout(() => {
                    const nextPlayer = room.players[room.currentPlayerIndex];
                    if (nextPlayer && nextPlayer.connected) {
                        const playableCards = getPlayableCards(nextPlayer.hand, room.currentTrick, room.trump);
                        
                        io.to(nextPlayer.id).emit('yourTurn', {
                            message: 'Your turn to lead!',
                            playableCards: playableCards
                        });
                        
                        // Notify others
                        room.players.forEach((player, index) => {
                            if (player && player.connected && index !== room.currentPlayerIndex) {
                                io.to(player.id).emit('turnUpdate', {
                                    currentPlayer: nextPlayer.name,
                                    currentPlayerIndex: room.currentPlayerIndex
                                });
                            }
                        });
                    }
                }, 3000);
            }
            
        } else {
            // Move to next player
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 4;
            const nextPlayer = room.players[room.currentPlayerIndex];
            
            if (nextPlayer && nextPlayer.connected) {
                const playableCards = getPlayableCards(nextPlayer.hand, room.currentTrick, room.trump);
                
                io.to(nextPlayer.id).emit('yourTurn', {
                    message: 'Your turn!',
                    playableCards: playableCards
                });
                
                // Notify others
                room.players.forEach((player, index) => {
                    if (player && player.connected && index !== room.currentPlayerIndex) {
                        io.to(player.id).emit('turnUpdate', {
                            currentPlayer: nextPlayer.name,
                            currentPlayerIndex: room.currentPlayerIndex
                        });
                    }
                });
            }
        }
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`Player disconnected: ${socket.id}, reason: ${reason}`);
        
        // Get room from player tracking
        const roomId = playerSockets.get(socket.id);
        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                const playerIndex = room.players.findIndex(p => p && p.id === socket.id);
                if (playerIndex !== -1) {
                    const playerName = room.players[playerIndex].name;
                    
                    // Mark player as disconnected but keep their slot
                    room.players[playerIndex].connected = false;
                    room.players[playerIndex].lastSeen = Date.now();
                    room.lastActivity = Date.now();
                    
                    logWithRoom(roomId, `${playerName} disconnected from position ${playerIndex}`);
                    
                    // Count remaining connected players
                    const connectedPlayers = room.players.filter(p => p && p.connected);
                    const connectedCount = connectedPlayers.length;
                    
                    // Notify remaining players
                    socket.to(roomId).emit('playerLeft', {
                        name: playerName,
                        remainingPlayers: connectedCount,
                        canContinue: connectedCount >= 2
                    });
                    
                    // Pause game if in progress and not enough players
                    if ((room.gameState === 'playing' || room.gameState === 'trump_selection') && connectedCount >= 1) {
                        logWithRoom(roomId, `Pausing game. Current state: ${room.gameState}`);
                        room.gameState = 'paused';
                        io.to(roomId).emit('gameInterrupted', {
                            message: `Game paused - ${playerName} disconnected`,
                            disconnectedPlayer: playerName
                        });
                        
                        console.log(`Game paused in room ${roomId} due to disconnection`);
                    }
                    
                    // Set up cleanup timer (remove player after 5 minutes of inactivity)
                    setTimeout(() => {
                        checkRoomHealth(roomId);
                    }, PLAYER_TIMEOUT);
                } else {
                    console.log(`Disconnected player not found in room ${roomId}`);
                }
            }
            
            // Remove from player tracking
            playerSockets.delete(socket.id);
        }
    });

    // Admin commands for monitoring (optional)
    socket.on('getServerStats', () => {
        if (socket.handshake.query.admin === 'true') {
            socket.emit('serverStats', getRoomStats());
        }
    });
});

// Enhanced periodic cleanup with better performance
setInterval(() => {
    const stats = getRoomStats();
    console.log(`🧹 Running cleanup... Rooms: ${stats.totalRooms}, Active: ${stats.activeRooms}, Players: ${stats.connectedPlayers}`);
    
    const roomsToCheck = Array.from(rooms.keys());
    let cleaned = 0;
    
    for (const roomId of roomsToCheck) {
        if (!checkRoomHealth(roomId)) {
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} rooms`);
    }
    
    console.log(`🧹 Cleanup complete. Active rooms: ${rooms.size}`);
}, ROOM_CLEANUP_INTERVAL);

// Server statistics logging
setInterval(() => {
    const stats = getRoomStats();
    console.log(`📊 Server Stats: ${stats.totalRooms} rooms (${stats.activeRooms} active), ${stats.connectedPlayers} players online`);
}, 5 * 60 * 1000); // Every 5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Omi Card Game Server running on port ${PORT}`);
    console.log(`🌐 Access the game at: http://localhost:${PORT}`);
    console.log(`📁 Serving files from: ${__dirname}`);
    console.log(`✅ Enhanced multi-room support enabled`);
    console.log(`✅ Team-based seating: Team A (Top/Bottom) vs Team B (Left/Right)`);
    console.log(`✅ Advanced reconnection system enabled`);
    console.log(`✅ Room limits: ${MAX_ROOMS} max rooms`);
    console.log(`✅ Auto-cleanup: ${PLAYER_TIMEOUT/1000/60} minutes for inactive players`);
    console.log(`✅ Health monitoring: ${ROOM_CLEANUP_INTERVAL/1000/60} minute intervals`);
});

// Enhanced graceful shutdown
let isShuttingDown = false;

process.on('SIGINT', () => {
    if (isShuttingDown) {
        console.log('\n🔴 Force closing...');
        process.exit(1);
    }
    
    isShuttingDown = true;
    console.log('\n🛑 Shutting down server...');
    
    // Notify all connected players about shutdown
    const stats = getRoomStats();
    console.log(`📊 Final stats: ${stats.totalRooms} rooms, ${stats.connectedPlayers} players`);
    
    for (const [roomId, room] of rooms) {
        room.players.forEach(player => {
            if (player && player.connected) {
                io.to(player.id).emit('serverShutdown', {
                    message: 'Server is shutting down. Please save your game state.'
                });
            }
        });
    }
    
    // Clear all tracking
    playerSockets.clear();
    rooms.clear();
    
    // Close all socket connections
    io.close(() => {
        console.log('📡 Socket.IO connections closed');
        
        // Close HTTP server
        server.close(() => {
            console.log('✅ Server closed gracefully');
            process.exit(0);
        });
        
        // Force close if it takes too long
        setTimeout(() => {
            console.log('⏰ Force closing after timeout');
            process.exit(1);
        }, 5000);
    });
});

// Enhanced error handling
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    if (!isShuttingDown) {
        // Log server stats before crash
        const stats = getRoomStats();
        console.error('📊 Server state at crash:', stats);
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    if (!isShuttingDown) {
        process.exit(1);
    }
});