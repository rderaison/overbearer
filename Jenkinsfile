pipeline {
    agent any

    environment {
        REGISTRY = 'ghcr.io/overbearer'
        IMAGE_TAG = "${env.BRANCH_NAME == 'main' ? 'latest' : env.BRANCH_NAME}-${env.BUILD_NUMBER}"
    }

    stages {
        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Typecheck') {
            parallel {
                stage('Proxy') {
                    steps {
                        sh 'npx tsc --noEmit -p packages/proxy/tsconfig.json'
                    }
                }
                stage('API') {
                    steps {
                        sh 'npx tsc --noEmit -p packages/api/tsconfig.json'
                    }
                }
                stage('UI') {
                    steps {
                        sh 'npx tsc --noEmit -p packages/ui/tsconfig.json'
                    }
                }
            }
        }

        stage('Unit Tests') {
            steps {
                sh 'cd e2e && npx vitest run --reporter=junit --outputFile=../test-results/unit.xml'
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: 'test-results/unit.xml'
                }
            }
        }

        stage('Build Images') {
            parallel {
                stage('Proxy Image') {
                    steps {
                        sh "docker build -f Dockerfile.proxy -t ${REGISTRY}/proxy:${IMAGE_TAG} ."
                    }
                }
                stage('Management Image') {
                    steps {
                        sh "docker build -f Dockerfile.api -t ${REGISTRY}/management:${IMAGE_TAG} ."
                    }
                }
            }
        }

        stage('Push Images') {
            when {
                anyOf {
                    branch 'main'
                    buildingTag()
                }
            }
            steps {
                withCredentials([usernamePassword(credentialsId: 'ghcr-credentials', usernameVariable: 'USER', passwordVariable: 'TOKEN')]) {
                    sh 'echo $TOKEN | docker login ghcr.io -u $USER --password-stdin'
                }
                sh "docker push ${REGISTRY}/proxy:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/management:${IMAGE_TAG}"
                script {
                    if (env.BRANCH_NAME == 'main') {
                        sh "docker tag ${REGISTRY}/proxy:${IMAGE_TAG} ${REGISTRY}/proxy:latest"
                        sh "docker tag ${REGISTRY}/management:${IMAGE_TAG} ${REGISTRY}/management:latest"
                        sh "docker push ${REGISTRY}/proxy:latest"
                        sh "docker push ${REGISTRY}/management:latest"
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f --filter="label=overbearer" || true'
        }
        failure {
            echo 'Build failed!'
        }
        success {
            echo "Images: ${REGISTRY}/proxy:${IMAGE_TAG}, ${REGISTRY}/management:${IMAGE_TAG}"
        }
    }
}
