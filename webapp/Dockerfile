FROM node:22-alpine

WORKDIR /app

COPY . .
RUN apk add --no-cache ffmpeg && npm ci --omit=dev --ignore-scripts && npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 8080

CMD ["npm", "start"]
