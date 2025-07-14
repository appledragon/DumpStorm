#!/bin/bash
# Release script for DumpStorm extension

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if version is provided
if [ $# -eq 0 ]; then
    print_error "Please provide a version number (e.g., 1.0.1)"
    echo "Usage: $0 <version> [--prerelease]"
    echo "Example: $0 1.0.1"
    echo "Example: $0 1.1.0-beta.1 --prerelease"
    exit 1
fi

VERSION=$1
PRERELEASE=false

if [ "$2" = "--prerelease" ]; then
    PRERELEASE=true
fi

# Validate version format
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9\.-]+)?$ ]]; then
    print_error "Invalid version format. Use semantic versioning (e.g., 1.0.1 or 1.1.0-beta.1)"
    exit 1
fi

# Check if we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    print_warning "You're not on the main branch. Current branch: $CURRENT_BRANCH"
    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Aborted by user"
        exit 1
    fi
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    print_error "You have uncommitted changes. Please commit or stash them first."
    exit 1
fi

print_info "Preparing release v$VERSION..."

# Update package.json version
print_info "Updating package.json version to $VERSION"
npm version $VERSION --no-git-tag-version

# Build and test
print_info "Building the extension..."
npm run compile

# Create git commit
print_info "Creating git commit..."
git add package.json
git commit -m "chore: bump version to v$VERSION"

# Create and push tag
TAG="v$VERSION"
print_info "Creating and pushing tag $TAG..."
git tag $TAG
git push origin main
git push origin $TAG

print_info "Release process initiated!"
print_info "Tag $TAG has been pushed to GitHub."
print_info "GitHub Actions will now:"
print_info "  1. Create a GitHub Release"
print_info "  2. Build and attach the .vsix file"
if [ "$PRERELEASE" = true ]; then
    print_info "  3. Mark as pre-release"
fi

print_info ""
print_info "Next steps:"
print_info "  1. Check the GitHub Actions progress at: https://github.com/appledragon/DumpStorm/actions"
print_info "  2. Review the created release at: https://github.com/appledragon/DumpStorm/releases"
print_info "  3. Manually trigger 'Publish to Marketplace' workflow if needed"

print_info ""
print_info "Release v$VERSION completed successfully! 🎉"
