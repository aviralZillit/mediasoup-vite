const initialState = {
	url: null,
	state: 'new', // new/connecting/connected/disconnected/closed,
	mediasoupVersion: null,
	mediasoupClientVersion: null,
	mediasoupClientHandler: undefined,
	activeSpeakerId: null,
	statsPeerId: null,
	faceDetection: false,
	recording: false,
	recordingInProgress: false,
	recordingComposing: false,
	recordingOutputUrl: null,
	chatOpen: false,
	chatMessages: [],
	chatUnread: 0,
};

const room = (state = initialState, action) => {
	switch (action.type) {
		case 'SET_ROOM_URL': {
			const { url } = action.payload;

			return { ...state, url };
		}

		case 'SET_ROOM_STATE': {
			const roomState = action.payload.state;

			if (roomState === 'connected') return { ...state, state: roomState };
			else
				return {
					...state,
					state: roomState,
					activeSpeakerId: null,
					statsPeerId: null,
				};
		}

		case 'SET_ROOM_MEDIASOUP_CLIENT_HANDLER': {
			const { mediasoupClientHandler } = action.payload;

			return { ...state, mediasoupClientHandler };
		}

		case 'SET_MEDIASOUP_VERSION': {
			const { version } = action.payload;

			return { ...state, mediasoupVersion: version };
		}

		case 'SET_MEDIASOUP_CLIENT_VERSION': {
			const { version } = action.payload;

			return { ...state, mediasoupClientVersion: version };
		}

		case 'SET_ROOM_ACTIVE_SPEAKER': {
			const { peerId } = action.payload;

			return { ...state, activeSpeakerId: peerId };
		}

		case 'SET_ROOM_STATS_PEER_ID': {
			const { peerId } = action.payload;

			if (state.statsPeerId === peerId) return { ...state, statsPeerId: null };

			return { ...state, statsPeerId: peerId };
		}

		case 'SET_FACE_DETECTION': {
			const flag = action.payload;

			return { ...state, faceDetection: flag };
		}

		case 'SET_RECORDING_STATE': {
			const { recording } = action.payload;

			return { ...state, recording };
		}

		case 'SET_RECORDING_IN_PROGRESS': {
			const { flag } = action.payload;

			return { ...state, recordingInProgress: flag };
		}

		case 'SET_RECORDING_COMPOSING': {
			const { flag } = action.payload;

			return { ...state, recordingComposing: flag };
		}

		case 'SET_RECORDING_READY': {
			const { outputFile } = action.payload;

			return { ...state, recordingComposing: false, recordingOutputUrl: outputFile };
		}

		case 'REMOVE_PEER': {
			const { peerId } = action.payload;
			const newState = { ...state };

			if (peerId && peerId === state.activeSpeakerId)
				newState.activeSpeakerId = null;

			if (peerId && peerId === state.statsPeerId) newState.statsPeerId = null;

			return newState;
		}

		case 'TOGGLE_CHAT_OPEN': {
			const chatOpen = !state.chatOpen;

			return {
				...state,
				chatOpen,
				chatUnread: chatOpen ? 0 : state.chatUnread,
			};
		}

		case 'ADD_CHAT_MESSAGE': {
			const { message } = action.payload;
			const chatMessages = [ ...state.chatMessages, message ];
			const chatUnread = state.chatOpen ? 0 : state.chatUnread + 1;

			return { ...state, chatMessages, chatUnread };
		}

		default: {
			return state;
		}
	}
};

export default room;
