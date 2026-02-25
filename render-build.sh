#!/bin/bash
set -e

echo "🚀 Starting Payment Service deployment..."

cd payment
# Instalar TODAS las dependencias (devDeps necesarias para nest build)
npm ci
npm run build

# Eliminar devDependencies después del build para reducir tamaño en deploy
npm prune --omit=dev

echo "✅ Payment service build completed!"
