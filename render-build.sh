#!/bin/bash
set -e

echo "🚀 Starting Payment Service deployment..."

cd payment
npm ci --only=production
npm run build

echo "✅ Payment service build completed!"
