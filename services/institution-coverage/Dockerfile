FROM oven/bun:1.3.5 AS bun
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS poppler

# Published PDF receipts require exact passage replay with the original extractor version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils g++ cmake ninja-build pkg-config \
      libfontconfig1-dev libfreetype-dev libjpeg-dev libopenjp2-7-dev liblcms2-dev libpng-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fSL --retry 3 https://poppler.freedesktop.org/poppler-26.01.0.tar.xz -o poppler.tar.xz \
 && echo '1cb944a4b88847f5fb6551683bc799db59f04990f5d8be07aba2acbf38601089  poppler.tar.xz' | sha256sum -c - \
 && tar -xf poppler.tar.xz \
 && cmake -S poppler-26.01.0 -B out -G Ninja -DCMAKE_BUILD_TYPE=Release '-DCMAKE_CXX_FLAGS_RELEASE=-O1 -DNDEBUG' \
      -DBUILD_SHARED_LIBS=OFF -DENABLE_BOOST=OFF -DENABLE_CPP=OFF -DENABLE_GLIB=OFF \
      -DENABLE_QT5=OFF -DENABLE_QT6=OFF -DENABLE_LIBCURL=OFF -DENABLE_LIBTIFF=OFF \
      -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF \
 && cmake --build out --target pdftotext --parallel 4 \
 && strip out/utils/pdftotext

FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libfontconfig1 libfreetype6 \
      libjpeg62-turbo libopenjp2-7 liblcms2-2 libpng16-16t64 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=poppler /build/out/utils/pdftotext /usr/local/bin/pdftotext

WORKDIR /app
COPY package.json bun.lock ./
COPY vendor/ ./vendor/
RUN bun install --production --frozen-lockfile
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY docs/evidence/ ./docs/evidence/
COPY services/funding/esdc-collector/html_tree.py ./services/funding/esdc-collector/html_tree.py
COPY services/institution-coverage/container/ ./services/institution-coverage/container/
COPY preview/geds/migrations/ ./preview/geds/migrations/
COPY preview/departmental-publications/migrations/ ./preview/departmental-publications/migrations/

RUN pdftotext -v && python3 -B scripts/federal-institution-coverage.py --help >/dev/null

EXPOSE 8080
CMD ["python3", "-B", "/app/services/institution-coverage/container/run.py"]
