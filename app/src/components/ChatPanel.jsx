import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import { withRoomContext } from '../RoomContext';
import * as stateActions from '../redux/stateActions';

class ChatPanel extends React.Component {
	constructor(props) {
		super(props);

		this.state = { text: '' };
		this._messagesEnd = null;
	}

	componentDidUpdate(prevProps) {
		// Auto-scroll to bottom when new messages arrive.
		if (prevProps.messages.length !== this.props.messages.length) {
			this._scrollToBottom();
		}
	}

	_scrollToBottom() {
		if (this._messagesEnd) {
			this._messagesEnd.scrollIntoView({ behavior: 'smooth' });
		}
	}

	_formatTime(ts) {
		const d = new Date(ts);

		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	_handleSend() {
		const text = this.state.text.trim();

		if (!text) return;

		this.props.roomClient.sendChatMessage(text);
		this.setState({ text: '' });
	}

	render() {
		const { messages, onClose, connected, chatDataProducer } = this.props;
		const { text } = this.state;
		const disabled = !connected || !chatDataProducer;

		return (
			<div data-component="ChatPanel">
				<div className="chat-header">
					<span className="chat-title">In-call messages</span>
					<button className="close-btn" onClick={onClose}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				<div className="chat-messages">
					{messages.length === 0 && (
						<div className="empty-state">
							<p>Messages can only be seen by people in the call and are deleted when the call ends.</p>
						</div>
					)}

					{messages.map((msg, i) => (
						<div
							key={i}
							className={`message ${msg.isMe ? 'me' : 'other'}`}
						>
							<div className="message-header">
								<span className="sender">{msg.isMe ? 'You' : msg.sender}</span>
								<span className="time">{this._formatTime(msg.timestamp)}</span>
							</div>
							<div className="message-text">{msg.text}</div>
						</div>
					))}

					<div ref={el => { this._messagesEnd = el; }} />
				</div>

				<div className="chat-input-area">
					<input
						type="text"
						placeholder={disabled ? 'Chat unavailable' : 'Send a message...'}
						disabled={disabled}
						value={text}
						onChange={e => this.setState({ text: e.target.value })}
						onKeyDown={e => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								this._handleSend();
							}
						}}
					/>
					<button
						className="send-btn"
						disabled={disabled || !text.trim()}
						onClick={() => this._handleSend()}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
							<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
						</svg>
					</button>
				</div>
			</div>
		);
	}
}

ChatPanel.propTypes = {
	roomClient: PropTypes.any.isRequired,
	messages: PropTypes.array.isRequired,
	connected: PropTypes.bool.isRequired,
	chatDataProducer: PropTypes.any,
	onClose: PropTypes.func.isRequired,
};

const mapStateToProps = state => {
	const dataProducersArray = Object.values(state.dataProducers);
	const chatDataProducer = dataProducersArray.find(
		dp => dp.label === 'chat'
	);

	return {
		messages: state.room.chatMessages,
		connected: state.room.state === 'connected',
		chatDataProducer,
	};
};

const ChatPanelContainer = withRoomContext(
	connect(mapStateToProps)(ChatPanel)
);

export default ChatPanelContainer;
