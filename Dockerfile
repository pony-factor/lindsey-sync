FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=8788

EXPOSE 8788

CMD ["npm", "start"]
