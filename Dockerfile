FROM node:20-bullseye

# Instalar Python y pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de Node.js
COPY package*.json ./
RUN npm install --production

# Instalar dependencias de Python (httpx para el daemon)
RUN pip3 install httpx python-dotenv

# Copiar el resto del proyecto
COPY . .

# Exponer el puerto del servidor web
EXPOSE 3000

# Archivo de inicio que levanta Node y Python simultáneamente
RUN echo '#!/bin/bash\n\
python3 vtiger_bridge/vtiger_watcher.py &\n\
npm start\n\
' > /app/start.sh

RUN chmod +x /app/start.sh

# El contenedor arranca ejecutando el script
CMD ["/app/start.sh"]
