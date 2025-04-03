/* eslint-disable max-len */
/* eslint-disable camelcase */
const mongoose = require('mongoose');

const { Schema } = mongoose;

const mediasoupCallSchema = mongoose.Schema({
	project_id     : { type: Schema.Types.ObjectId, required: true, index: true },
	start_time     : { type: Number, required: false, default: 0 }, // call start time
	end_time       : { type: Number, required: false, default: 0 }, // call end time
	call_type      : { type: String, required: false }, // audio or video
	room_id        : { type: String, required: false }, // room id
	voip_token     : { type: String, required: false },
	current_status : { type: String, required: false },
	is_random_call : { type: Boolean, required: true, default: false },
	call_mode      : { type: String, required: false }, // private or group
	chat_room_id   : {
		type : String, required : false, default : '', index : true
	}, // optional for private call
	is_247_call      : { type: Boolean, required: false, default: false },
	is_calendar_call : { type: Boolean, required: false, default: false },
	sender_user_id   : { type: Schema.Types.ObjectId, required: false },
	reciever_user_id : { type: Schema.Types.ObjectId, required: false },
	call_users       : [
		{
			device_id      : { type: Schema.Types.ObjectId, required: false },
			user_id        : { type: Schema.Types.ObjectId, required: true },
			current_status : { type: String, required: false, default: '' }, // invited or caller
			missed_call    : { type: Boolean, required: true, default: false },
			deleted        : { type: Number, required: true, default: 0 },
			created        : { type: Number, required: true, default: () => Date.now() }
		}
	],
	guest_users : [
		{
			current_status : { type: String, required: false, default: '' },
			user_name      : { type: String, required: true, default: '' },
			user_type      : { type: String, required: true, default: '' },
			created        : { type: Number, required: true, default: () => Date.now() }
		}
	]
});

module.exports = mongoose.model('mediasoupservercall', mediasoupCallSchema);
