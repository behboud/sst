FROM alpine:3.20 AS build
ARG BUILD_MARKER
RUN --mount=type=secret,id=BUILD_SECRET \
    test "$(cat /run/secrets/BUILD_SECRET)" = "fixture-secret" && \
    printf '%s' "$BUILD_MARKER" > /marker

FROM alpine:3.20 AS runtime
COPY --from=build /marker /marker
COPY . /context
RUN test ! -e /context/.env.local \
    && test ! -e /context/.sst/state.json \
    && test ! -e /run/secrets/BUILD_SECRET

FROM alpine:3.20 AS must-not-build
RUN echo "unselected stage should not run" >&2 && exit 99
