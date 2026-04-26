FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Cloud Run expects the app to listen on PORT (default 8080)
EXPOSE 8080

# Start the server
CMD ["npm", "start"]
