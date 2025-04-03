How Will the Client Know About All Connected Peers in the Room?

When a client joins a room, the server provides a list of all currently connected peers in response to the join request.

1️⃣ Client Sends a join Request.

Once the WebSocket connection is established, the client sends a join request to the server with its details:

2️⃣ Server Responds with a List of Connected Peers.

👉 Key Takeaways:
	•	The response to the join request contains a list of existing peers.
	•	Each peer in the list has:
	•	id
	•	displayName
	•	device info (e.g., browser type)

3️⃣ Client Updates UI with the Peers List.

⸻

How Does the Client Get Updates About New Peers?

After the initial list, the server notifies clients in real time when:
	1.	A new peer joins → newPeer event
	2.	A peer leaves → peerClosed event  
