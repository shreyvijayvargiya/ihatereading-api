FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
ENV SANDBOX_DATA_DIR=/data
EXPOSE 8080

CMD ["node", "server.js"]
