/* eslint-disable max-len */
const mongoose = require('mongoose');

const mediasoupCallSchema = new mongoose.Schema({
	roomId       : { type: String, required: true }, // mediasoup Room ID
	participants : [
		{
			peerId      : { type: mongoose.Schema.Types.ObjectId, required: true }, // Unique Peer ID
			displayName : { type: String, required: true },
			role        : { type: String, enum: [ 'caller', 'receiver' ] },
			joinedAt    : { type: Number, default: () => Date.now() }, // Store as Epoch Time (ms)
			leftAt      : { type: Number, default: null }, // Store as Epoch Time (ms)
			media       : {
				audio       : { type: Boolean, default: false },
				video       : { type: Boolean, default: false },
				screenShare : { type: Boolean, default: false }
			}
		}
	],
	callStatus : {
		type    : String,
		enum    : [ 'initiated', 'ongoing', 'ended', 'missed' ],
		default : 'initiated'
	},
	startedAt     : { type: Number, default: () => Date.now() }, // Store as Epoch Time (ms)
	endedAt       : { type: Number, default: null }, // Store as Epoch Time (ms)
	duration      : { type: Number, default: 0 }, // Call duration in seconds
	endedBy       : { type: mongoose.Schema.Types.ObjectId, default: null }, // PeerId of user who ended the call
	failureReason : { type: String, default: null } // If failed, store reason
});

// Export the model
module.exports = mongoose.model('mediasoupcall', mediasoupCallSchema);