# Use Node.js LTS (v20) as the base image
FROM node:20-slim

# Install Python 3 and other necessary system packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy the entire backend folder
COPY backend/ ./

# Install Node.js dependencies
RUN npm install

# Install Python dependencies
# Using --break-system-packages since we're in a container and don't need a venv
RUN if [ -f "prediction_engine/requirements.txt" ]; then \
    pip3 install --no-cache-dir -r prediction_engine/requirements.txt --break-system-packages; \
    fi

# Expose the port that the app runs on
EXPOSE 3000

# Set environment variable for Render (it uses PORT environment variable)
ENV PORT=3000

# Command to start the application
CMD ["npm", "start"]
