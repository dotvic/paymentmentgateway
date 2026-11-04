FROM node:22-alpine
WORKDIR /app
COPY package.json server.js tds.js store.js backup.js schemes.js disputes.js settlement.js mcp.js tutor.js glossary.js emv.js mag.js cardpresent.js ./
COPY public ./public
# Runs as root on purpose: Fly mounts the /data volume owned by root, and a non-root user could not write to it.
# The machine is an isolated VM, so this is acceptable here.
RUN mkdir -p /data
ENV DATA_FILE=/data/data.json DB_FILE=/data/zanboxx.db PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
