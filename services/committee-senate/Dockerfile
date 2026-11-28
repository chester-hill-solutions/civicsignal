FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY scripts/committee-catalogue.py ./scripts/
COPY scripts/lib/committee_files.py scripts/lib/wq_catalog.py scripts/lib/wq_store.py scripts/lib/html_tree.py ./scripts/lib/
COPY services/weekly-archive/runtime.py ./services/weekly-archive/
COPY services/institution-coverage/container/snapshot.py ./services/institution-coverage/container/
COPY services/committee-senate/run.py ./services/committee-senate/
RUN python3 -B services/committee-senate/run.py --help >/dev/null
EXPOSE 8080
CMD ["python3", "-B", "/app/services/committee-senate/run.py"]
