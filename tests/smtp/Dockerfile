FROM verde2/postfix:local
RUN apt-get update && apt-get install -y --no-install-recommends python3-dkim && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["python3"]
