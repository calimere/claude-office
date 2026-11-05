# Claude Office — le serveur de la flotte.
# Aucune dependance npm : il n'y a rien a installer, donc rien a auditer. L'image
# n'est qu'un Node et cinq fichiers.
FROM node:22-alpine

WORKDIR /app

# Les seuls fichiers dont le serveur a besoin. index.html est le bureau,
# install.html la procedure servie aux collegues, protocol.js et ws.js ses modules.
COPY server.js protocol.js ws.js index.html install.html ./

# Le roster (la liste des metiers deja vus) est la seule chose ecrite sur disque.
# Il vit dans /data, a monter sur un volume pour qu'il survive aux redemarrages.
RUN mkdir -p /data && chown node:node /data
ENV ROSTER_FILE=/data/roster.json

# On ecoute sur toutes les interfaces : dans un conteneur, 127.0.0.1 ne serait
# joignable que depuis le conteneur lui-meme.
ENV HOST=0.0.0.0
ENV PORT=4317
EXPOSE 4317

# Jamais en root : ce process accepte des connexions du reseau.
USER node

# /health plutot que /usage : il repond meme quand la page est protegee par mot de
# passe, et il ne revele rien de ce qui se passe dans le bureau.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4317)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
