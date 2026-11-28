FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /library-summaries && chown 65534:65534 /library-summaries
WORKDIR /app
COPY scripts/parliament-bills.py scripts/library-legislative-summaries.py ./scripts/
COPY scripts/lib/html_tree.py scripts/lib/library_summary_documents.py scripts/lib/parliament_intake.py ./scripts/lib/
COPY services/weekly-archive/runtime.py ./services/weekly-archive/
COPY services/institution-coverage/container/snapshot.py ./services/institution-coverage/container/
COPY services/library-summaries/run.py ./services/library-summaries/

USER 65534:65534
EXPOSE 8080
CMD ["python3", "-B", "/app/services/library-summaries/run.py"]
