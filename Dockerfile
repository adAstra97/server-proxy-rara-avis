FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]
