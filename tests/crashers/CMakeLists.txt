cmake_minimum_required(VERSION 3.20)
project(dumpstorm_crashers LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Debug symbols + no optimization for meaningful stack traces
if(MSVC)
    add_compile_options(/Zi /Od /Oy-)
    add_link_options(/DEBUG)
else()
    add_compile_options(-g -O0 -fno-omit-frame-pointer)
endif()

add_executable(crash_test main.cpp)

if(WIN32)
    target_link_libraries(crash_test dbghelp)
endif()
