FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
# Runs as root on purpose: Fly mounts the /data volume owned by root, and a non-root user could not write to it.
# The machine is an isolated VM, so this is acceptable here.
RUN mkdir -p /data
ENV DATA_FILE=/data/data.json PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
