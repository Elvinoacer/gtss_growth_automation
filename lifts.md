# delete the stale tag locally
git tag -d v1.0.0

# delete it on GitHub too — if you don't do this, pushing the new
# local tag will be rejected because the remote tag already exists
git push origin :refs/tags/v1.0.0

# re-create the tag at current main (now includes commit 6dadaf9)
git tag v1.0.0

# push the tag — this is what triggers the release workflow again
git push origin v1.0.0