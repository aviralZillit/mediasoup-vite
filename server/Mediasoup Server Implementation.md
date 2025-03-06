# Mediasoup Server Implementation

## Prerequisites
- A server with a public IP address
- A valid TLS certificate
- Node.js installed
- NPM installed
- Apache, Nginx, or any web server installed (for exposing `server/public`)
- PM2 (optional, for running as a daemon)
- Docker (optional, for containerization)

## Steps to Set Up Mediasoup Server

### 1. Upload the Server Folder
Upload your entire Mediasoup server folder to your hosting server.

### 2. Expose the Server's Public Folder
Configure your web server (Apache, Nginx, etc.) to expose the `server/public` folder.

### 3. Configure `server/config.js`
Edit the `server/config.js` file with appropriate settings:
- Set the listening IP and port.
- Configure logging options.
- Provide a valid TLS certificate.
- Ensure the announced IP and listen IP are correctly set.

### 4. Install Dependencies
Inside the `server` folder, run:
```sh
npm i --legacy-peer-deps
```

### 5. Set Up TLS Certificates
Ensure the TLS certificates reside in `server/certs` directory with the following names:
- `fullchain.pem`
- `privkey.pem`

### 6. Run the Server
Run the Node.js application with debugging enabled:
```sh
DEBUG="*mediasoup* *ERROR* *WARN*" node server.js
```

Or, run the provided bash script:
```sh
./run.sh
```

### 7. Running as a Daemon (Optional)
You can use `pm2` to run the server as a background process:
```sh
pm install -g pm2
pm2 start server.js --name mediasoup-server
```

To check logs and status:
```sh
pm2 logs mediasoup-server
pm2 status
```

### 8. Dockerizing the Server (Optional)
You can also choose to run Mediasoup in a Docker container for better management and deployment.

## Configuration Considerations
- Ensure `https.listenIp` is set to `0.0.0.0`.
- Map the server ports correctly.
- Make sure all required environment variables are set.
- The administrator can connect to the interactive terminal if needed.

## Troubleshooting
- Check the logs for errors using `DEBUG` mode.
- Ensure your web server is correctly forwarding requests to the Mediasoup server.
- Verify firewall settings to allow the necessary ports.
- Double-check TLS certificates and ensure they are valid.
