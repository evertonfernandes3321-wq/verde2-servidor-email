#!/bin/bash
# Script para iniciar o servidor de email

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Servidor de Email Transacional${NC}"
echo -e "${BLUE}========================================${NC}"

# Verificar se .env existe
if [ ! -f .env ]; then
    echo -e "${YELLOW}Arquivo .env não encontrado. Criando a partir do exemplo...${NC}"
    cp .env.example .env
    echo -e "${YELLOW}Por favor, edite o arquivo .env com suas configurações antes de continuar.${NC}"
    exit 1
fi

# Verificar dependências
echo -e "\n${GREEN}Verificando dependências...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker não está instalado. Instale o Docker primeiro.${NC}"
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}Docker Compose não está instalado. Instale o Docker Compose primeiro.${NC}"
    exit 1
fi

# Determinar qual comando usar
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

# Parar serviços anteriores
echo -e "\n${GREEN}Parando serviços anteriores...${NC}"
$DOCKER_COMPOSE down 2>/dev/null || true

# Iniciar serviços
echo -e "\n${GREEN}Iniciando serviços...${NC}"
$DOCKER_COMPOSE up -d

# Aguardar serviços ficarem saudáveis
echo -e "\n${GREEN}Aguardando serviços ficarem prontos...${NC}"
sleep 10

# Verificar status
echo -e "\n${GREEN}Verificando status dos serviços...${NC}"
$DOCKER_COMPOSE ps

# Testar health check
echo -e "\n${GREEN}Testando health check...${NC}"
sleep 5

if curl -s http://localhost:3000/health > /dev/null; then
    echo -e "${GREEN}✓ API está rodando!${NC}"
else
    echo -e "${YELLOW}⚠ API ainda não está pronta. Verifique os logs.${NC}"
fi

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Servidor iniciado com sucesso!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Acesse:"
echo "  - API:        http://localhost:3000"
echo "  - Health:     http://localhost:3000/health"
echo "  - Stats:      http://localhost:3000/api/v1/stats"
echo ""
echo "Logs:"
echo "  $DOCKER_COMPOSE logs -f"
echo ""
echo "Parar:"
echo "  $DOCKER_COMPOSE down"
