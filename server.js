// server.js
// This file runs on your Node.js server environment.

const express = require('express'); // Module to create a web server
const http = require('http');       // Node.js built-in module for HTTP
const socketIo = require('socket.io'); // Module for real-time bidirectional communication
const path = require('path');       // Node.js built-in module for file paths

// --- Server-side Game Constants ---
// These MUST match your client-side constants (N, WIN_LENGTH, PLAYER_X, PLAYER_O)
// The server needs these to validate moves and check for wins authoritatively.
const N = 7;
const WIN_LENGTH = 4;
const PLAYER_X = 'X';
const PLAYER_O = 'O';

// Server-side storage for active online games
// A basic structure to hold game data by room ID
// You'll need to manage creating, joining, and cleaning up these games
const games = {}; // Example structure:
                  // {
                  //   "some-unique-room-id": {
                  //     board: Array(N * N).fill(null), // The current state of the board
                  //     turn: 'X',                     // Whose turn it is ('X' or 'O')
                  //     players: {                     // Map of socket.id to player symbol
                  //       'socket-id-of-player-x': 'X',
                  //       'socket-id-of-player-o': 'O'
                  //     },
                  //     gameOver: false,               // Is the game over?
                  //     winner: null,                  // 'X', 'O', or null
                  //     isDraw: false,                 // Is it a draw?
                  //     winningCombination: null,      // Array of winning cell indices
                  //     gameStarted: false             // Has the game started (e.g., 2 players joined)?
                  //     // ... potentially more state ...
                  //   }
                  // }


// --- Helper function for server-side win check ---
// COPY this function exactly as it is from your client-side index.html's <script> block.
// The server must use the same logic to verify wins.
function checkForWinner(playerSymbol, boardLayout) {
    const N_check = N; // Use server-side N
    const W_check = WIN_LENGTH; // Use server-side WIN_LENGTH

    if (!boardLayout || !Array.isArray(boardLayout) || boardLayout.length !== N_check * N_check) {
         // console.error("Server: checkForWinner called with invalid boardLayout:", boardLayout); // Avoid excessive logging
         return null;
     }

    const directions = [
        { dr: 0, dc: 1 }, // Horizontal
        { dr: 1, dc: 0 }, // Vertical
        { dr: 1, dc: 1 }, // Diagonal /
        { dr: 1, dc: -1 } // Diagonal \
    ];

    // Iterate through all possible starting cells for a WIN_LENGTH line
    for (let r = 0; r < N_check; r++) {
        for (let c = 0; c < N_check; c++) {

             // Check for potential winning lines starting from (r, c) in each direction
             for (const direction of directions) {
                  let count = 0;
                  const combination = [];
                  let possible = true; // Assume it's a possible line for this player until proven otherwise

                  // Check WIN_LENGTH cells in this direction
                  for (let k = 0; k < W_check; k++) {
                      const currRow = r + k * direction.dr;
                      const currCol = c + k * direction.dc;
                      const currIndex = currRow * N_check + currCol;

                       if (currRow >= 0 && currRow < N_check && currCol >= 0 && currCol < N_check) {
                            // Check if the cell contains the correct player's symbol
                            if (boardLayout[currIndex] === playerSymbol) {
                                count++;
                                combination.push(currIndex);
                            } else {
                                // Found a cell that doesn't match, this is not a winning line starting here
                                possible = false;
                                break; // Move to the next direction or starting cell
                            }
                        } else {
                            // Went out of bounds, not a winning line starting here
                            possible = false;
                            break; // Move to the next direction or starting cell
                        }
                  }

                  // If we counted WIN_LENGTH symbols in a row and stayed in bounds
                  if (possible && count === W_check) {
                      console.log(`Server: Winner found: ${playerSymbol} at index ${r * N_check + c} in direction ${JSON.stringify(direction)}`);
                      return { player: playerSymbol, combination: combination };
                  }
             }
        }
    }

    return null; // No winner found
}

// --- Server Setup ---
const app = express();
const server = http.createServer(app);

// Attach Socket.IO to the HTTP server
// This creates the WebSocket server and makes the client library available at /socket.io/socket.io.js
const io = socketIo(server);

// Serve static files from the 'public' directory
// This line tells the server to look for files like index.html, styles.css, scripts.js,
// and files in subdirectories like /sounds/playing.wav inside the 'public' folder.
// When a browser requests '/', it automatically serves 'public/index.html'.
app.use(express.static(path.join(__dirname, 'public')));


// --- Socket.IO Server-side Game Logic ---
// This is the main event loop for Socket.IO connections.
io.on('connection', (socket) => {
  console.log('Server: A user connected:', socket.id);

  // When a client disconnects (closes tab, loses internet)
  socket.on('disconnect', (reason) => {
    console.log(`Server: User disconnected: ${socket.id} (${reason})`);

    // Find which game room this disconnected socket was associated with
    let disconnectedRoomId = null;
    let disconnectedPlayerSymbol = null;
    // Iterate through all active games to find the socket
    for (const roomId in games) {
        // Check if the game exists, has a players property, and if the socket.id is one of the players
        if (games[roomId] && games[roomId].players && games[roomId].players[socket.id]) {
            disconnectedRoomId = roomId;
            disconnectedPlayerSymbol = games[roomId].players[socket.id];
            break; // Found the game room
        }
    }

    if (disconnectedRoomId) {
        const game = games[disconnectedRoomId];

        // Remove the player's socket from the game's player list
        delete game.players[socket.id];
        console.log(`Server: Player ${disconnectedPlayerSymbol} (${socket.id}) removed from room ${disconnectedRoomId}. Remaining assigned players: ${Object.keys(game.players).length}`);

        // Determine what happens next based on the game state and remaining players
        const remainingAssignedPlayersCount = Object.keys(game.players).length;
        const actualSocketsInRoomCount = io.sockets.adapter.rooms.get(disconnectedRoomId)?.size || 0; // Count sockets still connected to the room

        if (game.gameStarted && !game.gameOver) {
             // If the game had started and wasn't finished by a win/draw, it now ends due to disconnect
             game.gameOver = true;
             game.winner = null; // No winner by disconnect
             game.isDraw = false;
             game.winningCombination = null;
             console.log(`Server: Game ${disconnectedRoomId} ended due to player disconnect.`);

             // Notify the remaining player(s) in the room
             // io.to(roomId) broadcasts to all sockets *in* the room.
             // Since the disconnected socket is gone, this targets the remaining one(s).
             io.to(disconnectedRoomId).emit('opponentDisconnected', {
                  message: `Opponent (${disconnectedPlayerSymbol === PLAYER_X ? PLAYER_O : PLAYER_X}) disconnected. Game ended.`,
                  // Send current board state etc. so the client can show the final board
                  board: game.board,
                  turn: game.turn, // Could set to null or 'disconnected' for client display
                  gameOver: game.gameOver,
                  winner: game.winner, // null
                  isDraw: game.isDraw, // false
                  winningCombination: game.winningCombination // null
             });

              // Set a timer to clean up the room data after a delay
              // This gives the remaining player time to see the message before the room state is gone.
              setTimeout(() => {
                  console.log(`Server: Cleaning up room ${disconnectedRoomId} after disconnect.`);
                   delete games[disconnectedRoomId];
                    // You might emit a 'roomClosed' event to any lingering sockets if needed
               }, 15000); // Clean up after 15 seconds

        } else if (remainingAssignedPlayersCount === 0 && actualSocketsInRoomCount === 0) {
             // If this was the last assigned player and no other sockets are lingering, clean up the game room immediately
             console.log(`Server: Last socket disconnected from room ${disconnectedRoomId}. Cleaning up empty room.`);
             delete games[disconnectedRoomId];
        } else {
             // The game was already over (win/draw), or it was still in the lobby phase (gameStarted is false)
             // or there might be multiple sockets from one client (less likely with this simple player logic).
             console.log(`Server: Disconnect from room ${disconnectedRoomId}. Game state was already finalized or room not full. Remaining players assigned: ${remainingAssignedPlayersCount}, Actual sockets in room: ${actualSocketsInRoomCount}.`);
             // Optional: Implement more sophisticated cleanup for incomplete or lingering rooms here.
             // If the room is empty of assigned players AND empty of actual sockets, clean it up.
             if (remainingAssignedPlayersCount === 0 && actualSocketsInRoomCount === 0) {
                 console.log(`Server: Room ${disconnectedRoomId} is now fully empty. Cleaning up.`);
                 delete games[disconnectedRoomId];
             }
        }
      } else {
           console.log(`Server: Disconnected socket ${socket.id} was not found in any active game room.`);
           // This handles sockets that connect but don't join a room, or disconnect from a lobby/waiting state outside a specific game room.
      }
  });


  // --- Handle Player Joining a Room ---
  // This event is emitted by your client when a user selects an online mode and provides room/symbol info.
  socket.on('joinGameRoom', (data) => {
      // data should contain roomId and mySymbol (X or O) from the client
      const { roomId, mySymbol } = data;
      console.log(`Server: Socket ${socket.id} requested to join room "${roomId}" as ${mySymbol}.`);

      // --- Basic Input Validation ---
      if (!roomId || typeof roomId !== 'string' || roomId.trim() === '' || (mySymbol !== PLAYER_X && mySymbol !== PLAYER_O)) {
          console.warn(`Server: Invalid join request from ${socket.id}:`, data);
          socket.emit('serverError', { message: 'Invalid join request. Please check room ID and symbol.' });
          return;
      }
       const cleanRoomId = roomId.trim(); // Use cleaned room ID

      // --- Room Management Logic ---
      let game = games[cleanRoomId];

      // If room doesn't exist, create it.
      // A real system would have a lobby page handle room creation explicitly.
      if (!game) {
          console.log(`Server: Room "${cleanRoomId}" does not exist. Creating.`);
          game = {
              board: Array(N * N).fill(null), // Initialize an empty board
              turn: PLAYER_X, // X always starts
              players: {}, // Map socket.id to player symbol (e.g., { 'abc123': 'X' })
              gameOver: false,
              winner: null,
              isDraw: false,
              winningCombination: null,
              gameStarted: false // Game starts when both player slots are filled
          };
          games[cleanRoomId] = game;
      }

      // --- Player Slot Assignment & Validation ---
      const currentPlayers = Object.values(game.players);
      const roomFull = currentPlayers.length >= 2; // Room is full if 2 or more players are assigned

      // Check if the requested symbol is already taken by a DIFFERENT socket
      const existingSocketIdForSymbol = Object.keys(game.players).find(sockId => game.players[sockId] === mySymbol);
      const isSymbolTakenByOther = existingSocketIdForSymbol && existingSocketIdForSymbol !== socket.id;

      // Handle Reconnect: Check if this socket.id is already listed in the game players with the correct symbol
      const isAlreadyInGameWithCorrectSymbol = game.players[socket.id] === mySymbol;


      if (isAlreadyInGameWithCorrectSymbol) {
           console.log(`Server: Socket ${socket.id} is reconnecting to room "${cleanRoomId}" as existing player ${mySymbol}.`);
           // Re-join the socket to the Socket.IO room (just in case they left and came back)
           socket.join(cleanRoomId);
           // Send the current game state to the re-connecting player
           socket.emit('gameState', {
                board: game.board, turn: game.turn, gameOver: game.gameOver,
                winner: game.winner, isDraw: game.isDraw, winningCombination: game.winningCombination,
                gameStarted: game.gameStarted
           });
           return; // Stop processing this join request further
      }

      if (roomFull) {
          console.warn(`Server: Room "${cleanRoomId}" is full. Rejecting join from ${socket.id}.`);
          socket.emit('serverError', { message: `Room "${cleanRoomId}" is already full.` });
          return;
      }

      if (isSymbolTakenByOther) {
           console.warn(`Server: Player ${mySymbol} slot taken in room "${cleanRoomId}". Rejecting join from ${socket.id}.`);
           socket.emit('serverError', { message: `Player ${mySymbol} slot is already taken in room "${cleanRoomId}".` });
           return;
      }

      // --- Assign Player to Room and Symbol ---
      game.players[socket.id] = mySymbol; // Assign this socket.id to the requested symbol
      socket.join(cleanRoomId); // Add socket to the Socket.IO room for easy broadcasting

      console.log(`Server: ${socket.id} assigned as ${mySymbol} in room "${cleanRoomId}". Current players: ${Object.values(game.players).join(', ')}. Sockets in room: ${io.sockets.adapter.rooms.get(cleanRoomId)?.size || 0}`);


      // --- Check if the game can now start ---
      // The game starts when both player slots (X and O) are filled by unique sockets.
       const hasPlayerX = Object.values(game.players).includes(PLAYER_X);
       const hasPlayerO = Object.values(game.players).includes(PLAYER_O);

      if (hasPlayerX && hasPlayerO) {
          game.gameStarted = true;
          console.log(`Server: Room "${cleanRoomId}" now has both players. Game started!`);

          // Broadcast the initial game state to both players now that the game can begin
          io.to(cleanRoomId).emit('gameState', {
              board: game.board, // Initial empty board state
              turn: game.turn, // Should be PLAYER_X
              gameOver: game.gameOver, // false
              winner: game.winner, // null
              isDraw: game.isDraw, // false
              winningCombination: game.winningCombination, // null
              gameStarted: game.gameStarted // true
          });
      } else {
          // Game hasn't started yet, waiting for the other player
          console.log(`Server: Room "${cleanRoomId}" waiting for opponent.`);
          // Send current state (waiting) to the joining player
           // You could also emit something specific like 'waitingForOpponent'
          socket.emit('gameState', { // Use socket.emit to send only to the joining player
               board: game.board, // Initial empty board
               turn: game.turn, // X's turn initially
               gameOver: game.gameOver, // false
               winner: game.winner, // null
               isDraw: game.isDraw, // false
               winningCombination: game.winningCombination, // null
               gameStarted: game.gameStarted // false
           });

           // You might want to inform the *other* player in the room (if any) that someone joined
           const otherSocketId = Object.keys(game.players).find(id => id !== socket.id);
           if (otherSocketId) {
                io.to(otherSocketId).emit('opponentJoined', { symbol: mySymbol }); // Or send updated list of players
           }
      }
  });

  // --- Handle Player Making a Move ---
  // This event is emitted by your client when a player clicks a cell in online mode.
  socket.on('makeMove', (data) => {
      // data should contain roomId, cellIndex
      const { roomId, cellIndex } = data;
      const game = games[roomId]; // Get the game state from server storage

      // --- Server-side Move Validation ---
      // This is CRITICAL for online games. Never trust the client's move!
      // 1. Does the game exist?
      if (!game) {
          console.warn(`Server: Move attempted in non-existent or ended room ${roomId} by ${socket.id}.`);
          socket.emit('invalidMove', { message: 'Game not found or already ended.' });
          return;
      }
      // 2. Is the game over?
      if (game.gameOver) {
           console.warn(`Server: Move attempted in finished game ${roomId} by ${socket.id}.`);
           socket.emit('invalidMove', { message: 'Game is already over.' });
           // Optionally re-send final game state?
           // io.to(roomId).emit('gameState', { ... final state ... });
           return;
      }
       // 3. Has the game actually started (both players joined)?
       if (!game.gameStarted) {
            console.warn(`Server: Move attempted in game ${roomId} before it started by ${socket.id}.`);
            socket.emit('invalidMove', { message: 'Waiting for opponent.' });
            return;
       }
      // 4. Is the socket ID associated with a player in this game?
       const playerSymbol = game.players[socket.id];
       if (!playerSymbol) {
           console.warn(`Server: Move attempted by socket ${socket.id} not assigned to a player in room ${roomId}.`);
           socket.emit('invalidMove', { message: 'You are not a player in this game.' });
           return;
       }
      // 5. Is it THIS player's turn?
      if (game.turn !== playerSymbol) {
           console.warn(`Server: Move attempted out of turn in room ${roomId}. Player: ${playerSymbol}, Expected Turn: ${game.turn}, Socket: ${socket.id}`);
           socket.emit('invalidMove', { message: 'It is not your turn.' });
           return;
      }
      // 6. Is the cell index valid (0 to N*N-1) and an integer?
      if (cellIndex === null || cellIndex === undefined || !Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= N * N) {
          console.warn(`Server: Invalid cell index ${cellIndex} received for room ${roomId} by ${socket.id}.`);
          socket.emit('invalidMove', { message: 'Invalid move index.' });
          return;
      }
      // 7. Is the cell already taken?
      if (game.board[cellIndex] !== null) {
          console.warn(`Server: Move attempted on taken cell ${cellIndex} in room ${roomId} by ${socket.id}.`);
          socket.emit('invalidMove', { message: 'Cell is already taken.' });
          return;
      }

      // --- If All Validation Passes: Apply the Move ---
      game.board[cellIndex] = playerSymbol; // Update the server's board state
      console.log(`Server: Valid move by ${playerSymbol} at index ${cellIndex} in room ${roomId}.`);

      // --- Check for Win or Draw AFTER the move ---
      const winnerInfo = checkForWinner(playerSymbol, game.board); // Use the server-side check!
      const boardIsFull = !game.board.includes(null);

      if (winnerInfo) {
          // Game Over - Winner!
          game.gameOver = true;
          game.winner = winnerInfo.player;
          game.isDraw = false; // Not a draw
          game.winningCombination = winnerInfo.combination; // Store winning combination
          console.log(`Server: Game Over in room ${roomId}. Winner: ${game.winner}`);

          // Broadcast the final game state to ALL clients in the room
          io.to(roomId).emit('gameState', {
               board: game.board, turn: game.turn, // Keep last turn as the winner's
               gameOver: game.gameOver, winner: game.winner, isDraw: game.isDraw, winningCombination: game.winningCombination,
               gameStarted: game.gameStarted // true
          });
           // Also emit a separate 'gameEnded' event for clarity (clients might use this for sounds/UI changes)
           io.to(roomId).emit('gameEnded', {
                winner: game.winner, isDraw: game.isDraw, winningCombination: game.winningCombination, board: game.board
           });

           // Optional: Set a timer to clean up the game room data after a delay
           // This prevents memory leaks from finished games.
           setTimeout(() => {
               console.log(`Server: Cleaning up room ${roomId} after game end.`);
               delete games[roomId]; // Remove the game state from server memory
                // You might emit a 'roomClosed' event to any lingering sockets if needed
           }, 60000); // Clean up after 1 minute

      } else if (boardIsFull) {
          // Game Over - Draw! (No winner and no empty cells)
          game.gameOver = true;
          game.isDraw = true;
          game.winner = null; // No winner
          game.winningCombination = null; // No winning combination
          console.log(`Server: Game Over in room ${roomId}. Draw.`);

          // Broadcast the final state to ALL clients in the room
          io.to(roomId).emit('gameState', {
              board: game.board, turn: game.turn, // Keep last turn
              gameOver: game.gameOver, winner: game.winner, isDraw: game.isDraw, winningCombination: game.winningCombination,
              gameStarted: game.gameStarted // true
          });
           // Also emit a separate 'gameEnded' event for clarity
           io.to(roomId).emit('gameEnded', {
                winner: game.winner, // Will be null here
                isDraw: game.isDraw, // Will be true here
                winningCombination: game.winningCombination, // Will be null here
                board: game.board
           });

           // Optional: Set a timer to clean up the game room data after a delay
           setTimeout(() => {
               console.log(`Server: Cleaning up room ${roomId} after draw.`);
                delete games[roomId];
           }, 60000); // Clean up after 1 minute

      } else {
          // Game is NOT over - Switch Turn
          game.turn = playerSymbol === PLAYER_X ? PLAYER_O : PLAYER_X; // Switch the turn symbol
          console.log(`Server: Turn switched in room ${roomId} to ${game.turn}.`);

          // Broadcast the updated game state to ALL clients in the room
          io.to(roomId).emit('gameState', {
              board: game.board,
              turn: game.turn,
              gameOver: game.gameOver, // false
              winner: game.winner, // null
              isDraw: game.isDraw, // false
              winningCombination: game.winningCombination, // null
              gameStarted: game.gameStarted // true
          });
      }
  });

  // Handle connection errors (e.g., network issues on the server side)
  socket.on('connect_error', (err) => {
      console.error('Server: Socket Connection Error:', err.message);
       // The 'disconnect' event typically follows a 'connect_error', so cleanup logic is primarily handled there.
       // You might emit a server-side error event back to the client if the connection drops after initial handshake
       // socket.emit('serverError', { message: 'Connection error occurred.' }); // This might not reach the client if the connection is already bad
  });

}); // End of io.on('connection', ...)


// --- Start the Server ---
// Define the port for the server to listen on
// Use process.env.PORT for hosting platforms (like Render, Heroku, Glitch)
// Default to 3000 for local development/testing
const PORT = process.env.PORT || 3000;

// Start the HTTP server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the game at: http://localhost:${PORT}`); // For local testing
});