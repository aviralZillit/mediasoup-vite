import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import classnames from 'classnames';
import * as appPropTypes from './appPropTypes';
import { Appear } from './transitions';
import Peer from './Peer';

const Peers = ({ peers, activeSpeakerId, pinnedPeerId, peerShareStatus }) => {
	// Build list of all tiles (each peer can have webcam tile and/or share tile)
	const allTiles = [];
	
	peers.forEach(peer => {
		const hasShare = peerShareStatus[peer.id];
		
		// Add webcam tile
		allTiles.push({
			key: peer.id,
			peerId: peer.id,
			peer,
			isShare: false,
			tileId: peer.id,
		});
		
		// Add separate share tile if peer is sharing
		if (hasShare) {
			allTiles.push({
				key: `${peer.id}-share`,
				peerId: peer.id,
				peer,
				isShare: true,
				tileId: `${peer.id}-share`,
			});
		}
	});

	// Find the pinned tile if exists
	const pinnedTile = pinnedPeerId 
		? allTiles.find(t => t.tileId === pinnedPeerId || t.tileId === pinnedPeerId) 
		: null;
	const unpinnedTiles = pinnedPeerId 
		? allTiles.filter(t => t.tileId !== pinnedPeerId) 
		: [];

	// If no one is pinned, render original layout exactly as before
	if (!pinnedTile) {
		return (
			<div data-component="Peers">
				{allTiles.map(tile => {
					return (
						<Appear key={tile.key} duration={1000}>
							<div
								className={classnames('peer-container', {
									'active-speaker': tile.peerId === activeSpeakerId,
									'share-tile': tile.isShare,
								})}
							>
								<Peer id={tile.peerId} showShare={tile.isShare} showWebcam={!tile.isShare} />
							</div>
						</Appear>
					);
				})}
			</div>
		);
	}

	// Pinned layout - only when someone is pinned
	return (
		<div data-component="Peers" className="has-pinned">
			{/* Pinned tile - shown large */}
			<div className="pinned-container">
				<Appear key={pinnedTile.key} duration={300}>
					<div
						className={classnames('peer-container', 'pinned', {
							'active-speaker': pinnedTile.peerId === activeSpeakerId,
							'share-tile': pinnedTile.isShare,
						})}
					>
						<Peer id={pinnedTile.peerId} showShare={pinnedTile.isShare} showWebcam={!pinnedTile.isShare} />
					</div>
				</Appear>
			</div>

			{/* Unpinned tiles - shown in sidebar */}
			{unpinnedTiles.length > 0 && (
				<div className="peers-sidebar">
					{unpinnedTiles.map(tile => {
						return (
							<Appear key={tile.key} duration={500}>
								<div
									className={classnames('peer-container', 'sidebar-peer', {
										'active-speaker': tile.peerId === activeSpeakerId,
										'share-tile': tile.isShare,
									})}
								>
									<Peer id={tile.peerId} showShare={tile.isShare} showWebcam={!tile.isShare} />
								</div>
							</Appear>
						);
					})}
				</div>
			)}
		</div>
	);
};

Peers.propTypes = {
	peers: PropTypes.arrayOf(appPropTypes.Peer).isRequired,
	activeSpeakerId: PropTypes.string,
	pinnedPeerId: PropTypes.string,
	peerShareStatus: PropTypes.object.isRequired,
};

const mapStateToProps = state => {
	const peersArray = Object.values(state.peers);
	
	// Build a map of peerId -> hasShare
	const peerShareStatus = {};
	peersArray.forEach(peer => {
		const consumersArray = peer.consumers.map(
			consumerId => state.consumers[consumerId]
		);
		const shareConsumer = consumersArray.find(
			consumer => consumer && consumer.track?.kind === 'video' && consumer.appData?.share
		);
		peerShareStatus[peer.id] = Boolean(shareConsumer);
	});

	return {
		peers: peersArray,
		activeSpeakerId: state.room.activeSpeakerId,
		pinnedPeerId: state.room.pinnedPeerId,
		peerShareStatus,
	};
};

const PeersContainer = connect(mapStateToProps, null, null, {
	areStatesEqual: (next, prev) => {
		return (
			prev.peers === next.peers &&
			prev.room.activeSpeakerId === next.room.activeSpeakerId &&
			prev.room.pinnedPeerId === next.room.pinnedPeerId &&
			prev.consumers === next.consumers
		);
	},
})(Peers);

export default PeersContainer;
