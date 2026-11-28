"""Release entry for fixed evidence, legacy reports and desktop/cloud acceptance."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromNames([
        "tests.test_task_acceptance_review.AcceptanceReviewTests",
        "tests.test_cloud_acceptance.MobileAcceptanceTests",
    ])


if __name__ == "__main__":
    unittest.main()
