# Builds libffnative.so -- the on-device inference engine.
#
# The sources are upstream's, vendored unmodified under third_party/ (ADR-0004). This
# file is ours because the paths differ in this repo: their sources sit beside their
# CMakeLists, ours sit two directories away, and the QNN headers live under our
# android/src/main/cpp/include/. The compile flags and the link line below are
# identical to theirs on purpose -- see third_party/facefusion-mobile/NOTICE.
cmake_minimum_required(VERSION 3.22.1)
project(ffnative)

set(FF_UPSTREAM "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/facefusion-mobile/cpp")

# Both of these are fetched, not committed, and both fail here rather than 200 lines
# into a compiler error nobody can read. See docs/03-setup.md.
if(NOT EXISTS "${FF_UPSTREAM}/ffjni.cpp")
  message(FATAL_ERROR
    "Upstream C++ engine is missing from third_party/facefusion-mobile/cpp/.\n"
    "It is not committed to this repo (no upstream licence -- docs/05-licensing.md).\n"
    "Run:  ./scripts/fetch-upstream.sh")
endif()

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/include/QNN/QnnBackend.h")
  message(FATAL_ERROR
    "Qualcomm QNN headers are missing from android/src/main/cpp/include/QNN/.\n"
    "The QAIRT SDK is proprietary and cannot be shipped in this package.\n"
    "See docs/03-setup.md for the download and the exact file list.")
endif()

# The same four objects upstream's app and headless CLI both link.
add_library(ffnative SHARED
    "${FF_UPSTREAM}/ffjni.cpp"
    "${FF_UPSTREAM}/ffpipe.cpp"
    "${FF_UPSTREAM}/ffcv.cpp"
    "${FF_UPSTREAM}/ffqnn.cpp")

# Three roots: the vendored sources include their own headers unqualified ("ffcv.h");
# ffqnn.cpp includes "QNN/QnnBackend.h"; and the SDK's own sub-headers include their
# siblings unqualified, so include/QNN has to be on the path as well as include.
target_include_directories(ffnative PRIVATE
    "${FF_UPSTREAM}"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/QNN")

# No QNN library is linked. libQnnHtp.so / libQnnSystem.so are dlopen'd at runtime by
# absolute path out of the app's nativeLibraryDir, which is why this builds against the
# headers alone and why useLegacyPackaging must stay true (docs/01-architecture.md).
target_link_libraries(ffnative android log dl)
target_compile_options(ffnative PRIVATE -O3 -fvisibility=hidden -Wall)
